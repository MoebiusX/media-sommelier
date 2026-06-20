/**
 * Real filesystem walker — used when the engine runs on a machine with the collection mounted.
 *
 * Async, bounded, symlink-cycle-guarded directory traversal producing MediaFileRecords. Tag reading
 * is intentionally NOT done here in V0 (the reconstruction path works from filenames/folders); a tag
 * adapter is layered on later so the cheap-first staged pipeline from the plan holds.
 *
 * Network-drive robustness: directory/stat reads are RETRIED on transient errors (network drives
 * intermittently fail mid-walk). Directories that still fail are reported via `onSkip` instead of
 * silently vanishing — a silent partial walk is worse than a loud one (it looks like data loss).
 */
import { readdir, stat, realpath } from 'node:fs/promises';
import { join, dirname, basename as pathBasename } from 'node:path';
import type { MediaFileRecord, MediaType } from '../types.js';
import { extOf, mediaTypeForExt } from '../text.js';

export interface WalkOptions {
  include?: MediaType[];
  ignoreDirs?: string[];
  limit?: number;
  /** Called when a directory or file is skipped after retries (path + error). */
  onSkip?: (path: string, error: unknown) => void;
  /** Retry attempts for transient FS errors (default 3). */
  retries?: number;
}

const DEFAULT_IGNORE = ['node_modules', '.git', '$recycle.bin', 'system volume information'];
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function retry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await delay(80 * (i + 1));
    }
  }
  throw lastErr;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function* walk(root: string, opts: WalkOptions = {}): AsyncGenerator<MediaFileRecord> {
  const ignore = new Set([...DEFAULT_IGNORE, ...(opts.ignoreDirs ?? [])].map((s) => s.toLowerCase()));
  const include = opts.include ? new Set(opts.include) : null;
  const attempts = opts.retries ?? 3;
  const seen = new Set<string>();
  let count = 0;

  async function* recur(dir: string): AsyncGenerator<MediaFileRecord> {
    let real: string;
    try {
      real = await retry(() => realpath(dir), attempts);
    } catch (e) {
      opts.onSkip?.(dir, e);
      return;
    }
    if (seen.has(real)) return; // cycle guard
    seen.add(real);

    let entries;
    try {
      entries = await retry(() => readdir(dir, { withFileTypes: true }), attempts);
    } catch (e) {
      opts.onSkip?.(dir, e); // surfaced, not silently dropped
      return;
    }

    for (const entry of entries) {
      if (opts.limit && count >= opts.limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name.toLowerCase())) continue;
        yield* recur(full);
      } else if (entry.isFile()) {
        const ext = extOf(entry.name);
        const mediaType = mediaTypeForExt(ext);
        if (include && !include.has(mediaType)) continue;
        let st;
        try {
          st = await retry(() => stat(full), attempts);
        } catch (e) {
          opts.onSkip?.(full, e);
          continue;
        }
        count++;
        yield {
          path: full,
          dir: dirname(full),
          name: pathBasename(full),
          ext,
          sizeBytes: st.size,
          mtime: toIso(st.mtime),
          mediaType,
        };
      }
    }
  }

  yield* recur(root);
}

export async function walkToArray(root: string, opts: WalkOptions = {}): Promise<MediaFileRecord[]> {
  const out: MediaFileRecord[] = [];
  for await (const rec of walk(root, opts)) out.push(rec);
  return out;
}
