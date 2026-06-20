/**
 * Real filesystem walker — used when the engine runs on a machine with the collection mounted.
 *
 * Async, bounded, symlink-cycle-guarded directory traversal producing MediaFileRecords. Tag reading
 * is intentionally NOT done here in V0 (the reconstruction path works from filenames/folders); a tag
 * adapter is layered on later so the cheap-first staged pipeline from the plan holds.
 */
import { opendir, stat, realpath } from 'node:fs/promises';
import { join, dirname, basename as pathBasename } from 'node:path';
import type { MediaFileRecord, MediaType } from '../types.js';
import { extOf, mediaTypeForExt } from '../text.js';

export interface WalkOptions {
  /** Only keep these media types (default: all). */
  include?: MediaType[];
  /** Skip directories whose basename matches any of these (case-insensitive). */
  ignoreDirs?: string[];
  /** Hard cap on files returned (safety valve in V0). */
  limit?: number;
}

const DEFAULT_IGNORE = ['node_modules', '.git', '$recycle.bin', 'system volume information'];

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Walk `root` and yield media file records. Streams to bound memory; resolves realpaths to break cycles. */
export async function* walk(root: string, opts: WalkOptions = {}): AsyncGenerator<MediaFileRecord> {
  const ignore = new Set([...DEFAULT_IGNORE, ...(opts.ignoreDirs ?? [])].map((s) => s.toLowerCase()));
  const include = opts.include ? new Set(opts.include) : null;
  const seen = new Set<string>();
  let count = 0;

  async function* recur(dir: string): AsyncGenerator<MediaFileRecord> {
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return; // cycle guard
    seen.add(real);

    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return; // unreadable dir — skip, don't crash a 1M scan
    }
    for await (const entry of handle) {
      if (opts.limit && count >= opts.limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name.toLowerCase())) continue;
        yield* recur(full);
      } else if (entry.isFile()) {
        const ext = extOf(entry.name);
        const mediaType = mediaTypeForExt(ext);
        if (include && !include.has(mediaType)) continue;
        let sizeBytes = 0;
        let mtime = '1970-01-01';
        try {
          const st = await stat(full);
          sizeBytes = st.size;
          mtime = toIso(st.mtime);
        } catch {
          continue;
        }
        count++;
        yield {
          path: full,
          dir: dirname(full),
          name: pathBasename(full),
          ext,
          sizeBytes,
          mtime,
          mediaType,
        };
      }
    }
  }

  yield* recur(root);
}

/** Convenience: collect a walk into an array (fine for V0 scale; streaming used at 1M). */
export async function walkToArray(root: string, opts: WalkOptions = {}): Promise<MediaFileRecord[]> {
  const out: MediaFileRecord[] = [];
  for await (const rec of walk(root, opts)) out.push(rec);
  return out;
}
