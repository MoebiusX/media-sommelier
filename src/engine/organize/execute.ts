/**
 * Organize EXECUTOR — copies files into the new tree, verifying every copy by hash.
 *
 * Safety contract (hardened after an adversarial review):
 *  - SOURCE is only ever READ. The single source read happens while streaming the copy (hash computed
 *    on the bytes being copied — no second read, no TOCTOU window), and the source is never renamed,
 *    truncated, or deleted.
 *  - Destination must be OUTSIDE the source tree (enforced when sourceRoot is supplied) so we can never
 *    write a copy on top of a source file or have a re-scan re-ingest the output.
 *  - Colliding destinations (two sources → one path) are FAILED, never silently overwritten.
 *  - Each copy goes to a unique temp file, is verified, fsync'd, tagged (tag-then-publish), then
 *    atomically renamed into place. A failed action cleans up its temp. Idempotent: an existing
 *    destination is skipped (so --writeTags re-runs don't re-clobber already-organized files).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, rm, open } from 'node:fs/promises';
import { dirname, basename, join, resolve, relative, isAbsolute } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { OrganizePlan, OrganizeAction } from './plan.js';
import { writeTrackTags } from './tag.js';
import { isAudioExt, extOf } from '../text.js';

export interface ExecuteOptions {
  dryRun?: boolean;
  /** Stamp corrected tags onto each copy (tag-then-publish) — default false. */
  writeTags?: boolean;
  /** Source root the inventory was walked from; if set, dest is asserted disjoint from it. */
  sourceRoot?: string;
  onProgress?: (done: number, total: number, action: OrganizeAction) => void;
}

export interface ActionResult {
  action: OrganizeAction;
  status: 'copied' | 'skipped' | 'failed';
  sourceHash?: string;
  copyHash?: string;
  bytes?: number;
  tagWritten?: boolean;
  tagError?: string;
  reason?: string;
  error?: string;
}

export interface ExecuteReport {
  results: ActionResult[];
  copied: number;
  skipped: number;
  failed: number;
  tagged: number;
  bytesCopied: number;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), async function* (src) {
    for await (const chunk of src) hash.update(chunk as Buffer);
  });
  return hash.digest('hex');
}

/** Stream source → temp, hashing the bytes as they pass (one read of the source). `wx` => never reuse a temp. */
async function copyAndHash(src: string, tmp: string): Promise<string> {
  const hash = createHash('sha256');
  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk as Buffer);
      cb(null, chunk);
    },
  });
  await pipeline(createReadStream(src), hasher, createWriteStream(tmp, { flags: 'wx' }));
  return hash.digest('hex');
}

export async function executePlan(plan: OrganizePlan, opts: ExecuteOptions = {}): Promise<ExecuteReport> {
  // dest-vs-source safety: never write the organized tree into the source tree
  if (opts.sourceRoot) {
    const src = resolve(opts.sourceRoot);
    const dst = resolve(plan.destRoot);
    if (src === dst || isInside(src, dst) || isInside(dst, src)) {
      throw new Error(`Refusing to organize: destination "${dst}" overlaps the source tree "${src}". Choose a destination OUTSIDE the source.`);
    }
  }
  const colliding = new Set(plan.collisions.map((c) => c.destRelPath));

  const results: ActionResult[] = [];
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  let tagged = 0;
  let bytesCopied = 0;

  for (let i = 0; i < plan.actions.length; i++) {
    const action = plan.actions[i]!;
    opts.onProgress?.(i + 1, plan.actions.length, action);

    if (colliding.has(action.destRelPath)) {
      results.push({ action, status: 'failed', error: 'destination collision (multiple sources map to this path)' });
      failed++;
      continue;
    }
    if (await exists(action.destPath)) {
      results.push({ action, status: 'skipped', reason: 'destination already exists' });
      skipped++;
      continue;
    }
    if (opts.dryRun) {
      results.push({ action, status: 'skipped', reason: 'dry-run' });
      skipped++;
      continue;
    }

    // unique, hidden temp in the dest dir that KEEPS the real extension (node-taglib-sharp keys off it)
    const tmp = join(dirname(action.destPath), `.somm-${process.pid}-${randomUUID()}-${basename(action.destPath)}`);
    try {
      const { size } = await stat(action.sourcePath);
      await mkdir(dirname(action.destPath), { recursive: true });

      const sourceHash = await copyAndHash(action.sourcePath, tmp); // single source read
      const copyHash = await sha256(tmp); // verify what actually landed on disk
      if (copyHash !== sourceHash) throw new Error(`hash mismatch after copy (${sourceHash.slice(0, 12)} != ${copyHash.slice(0, 12)})`);

      const fh = await open(tmp, 'r+'); // durability: flush to disk before publishing
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }

      // tag the TEMP (tag-then-publish), only for audio; a tag failure never fails the copy
      let tagWritten: boolean | undefined;
      let tagError: string | undefined;
      if (opts.writeTags && action.tags && isAudioExt(extOf(action.destPath))) {
        try {
          writeTrackTags(tmp, action.tags);
          tagWritten = true;
        } catch (e) {
          tagError = e instanceof Error ? e.message : String(e);
        }
      }

      await rename(tmp, action.destPath); // atomic publish
      if (tagWritten) tagged++;
      results.push({ action, status: 'copied', sourceHash, copyHash, bytes: size, ...(tagWritten ? { tagWritten } : {}), ...(tagError ? { tagError } : {}) });
      copied++;
      bytesCopied += size;
    } catch (err) {
      await rm(tmp, { force: true }); // never leak a temp on failure
      results.push({ action, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      failed++;
    }
  }

  return { results, copied, skipped, failed, tagged, bytesCopied };
}
