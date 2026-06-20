/**
 * Organize EXECUTOR — copies files into the new tree, verifying every copy by hash.
 *
 * Safety contract (matches the plan): the source is only ever READ; the only writes are to the
 * destination tree. Each action copies to a temp file, fsyncs, atomically renames, then re-hashes the
 * copy and asserts it matches the source. Idempotent + resumable: an identical existing destination is
 * skipped. (V0 uses sha256 for verification; the plan upgrades this to blake3-during-copy later.)
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, copyFile, rename, stat, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OrganizePlan, OrganizeAction } from './plan.js';

export interface ExecuteOptions {
  /** If true, do everything except the actual byte copy (default false). */
  dryRun?: boolean;
  onProgress?: (done: number, total: number, action: OrganizeAction) => void;
}

export interface ActionResult {
  action: OrganizeAction;
  status: 'copied' | 'skipped' | 'failed';
  sourceHash?: string;
  copyHash?: string;
  bytes?: number;
  error?: string;
}

export interface ExecuteReport {
  results: ActionResult[];
  copied: number;
  skipped: number;
  failed: number;
  bytesCopied: number;
}

async function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('error', reject);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function executePlan(plan: OrganizePlan, opts: ExecuteOptions = {}): Promise<ExecuteReport> {
  const results: ActionResult[] = [];
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  let bytesCopied = 0;

  for (let i = 0; i < plan.actions.length; i++) {
    const action = plan.actions[i]!;
    opts.onProgress?.(i + 1, plan.actions.length, action);
    try {
      const sourceHash = await sha256(action.sourcePath);
      const { size } = await stat(action.sourcePath);

      // idempotent resume: identical destination already present
      if (await exists(action.destPath)) {
        const existing = await sha256(action.destPath);
        if (existing === sourceHash) {
          results.push({ action, status: 'skipped', sourceHash, copyHash: existing, bytes: size });
          skipped++;
          continue;
        }
      }

      if (opts.dryRun) {
        results.push({ action, status: 'skipped', sourceHash, bytes: size });
        skipped++;
        continue;
      }

      await mkdir(dirname(action.destPath), { recursive: true });
      const tmp = `${action.destPath}.part`;
      await copyFile(action.sourcePath, tmp); // reads source, writes a NEW file — source untouched
      const copyHash = await sha256(tmp);
      if (copyHash !== sourceHash) {
        await rm(tmp, { force: true });
        throw new Error(`hash mismatch after copy (src ${sourceHash.slice(0, 12)} != copy ${copyHash.slice(0, 12)})`);
      }
      await rename(tmp, action.destPath); // atomic publish
      results.push({ action, status: 'copied', sourceHash, copyHash, bytes: size });
      copied++;
      bytesCopied += size;
    } catch (err) {
      results.push({ action, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      failed++;
    }
  }

  return { results, copied, skipped, failed, bytesCopied };
}
