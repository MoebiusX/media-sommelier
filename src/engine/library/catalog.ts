/**
 * Persistent catalog cache (the modern take on apiserver's file-backed LokiJS). Tags are expensive to
 * read, so we cache them on disk keyed by path; on re-scan, a file whose size+mtime are unchanged reuses
 * its cached tags and only NEW/CHANGED files are re-read. Removed files drop out. Re-scans go from
 * minutes to instant. (A SQLite backend can swap in later behind this same API.)
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { walkToArray } from '../inventory/walk.js';
import { readTags } from '../inventory/tags.js';
import type { TagInfo } from '../inventory/tags.js';
import { stem } from '../text.js';
import type { Track } from './scan.js';

const VERSION = 1;
interface CacheEntry { size: number; mtime: string; tags: TagInfo; }
interface CacheFile { root: string; version: number; entries: Record<string, CacheEntry>; }

export interface CachedScanResult {
  tracks: Track[];
  cached: number; // reused from disk (unchanged)
  scanned: number; // tags freshly read (new or changed)
  removed: number; // dropped (no longer on disk)
}

export interface CachedScanOptions {
  cacheDir?: string;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function scanLibraryCached(root: string, opts: CachedScanOptions = {}): Promise<CachedScanResult> {
  const cacheDir = opts.cacheDir ?? 'data/catalogs';
  const cachePath = join(cacheDir, createHash('sha1').update(root.toLowerCase()).digest('hex') + '.json');

  let cache: CacheFile = { root, version: VERSION, entries: {} };
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8')) as CacheFile;
    if (parsed.version === VERSION) cache = parsed;
  } catch {
    /* no cache yet */
  }

  const records = await walkToArray(root, { include: ['music'] });
  const next: Record<string, CacheEntry> = {};
  const tracks = new Array<Track>(records.length);
  let cached = 0, scanned = 0, done = 0, idx = 0;

  const worker = async (): Promise<void> => {
    while (idx < records.length) {
      const i = idx++;
      const rec = records[i]!;
      const prev = cache.entries[rec.path];
      let tags: TagInfo;
      if (prev && prev.size === rec.sizeBytes && prev.mtime === rec.mtime) {
        tags = prev.tags;
        cached++;
      } else {
        tags = await readTags(rec.path);
        scanned++;
      }
      next[rec.path] = { size: rec.sizeBytes, mtime: rec.mtime, tags };
      tracks[i] = { ...rec, ...tags, title: tags.title || stem(rec.name) };
      opts.onProgress?.(++done, records.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, opts.concurrency ?? 8), records.length || 1) }, worker));

  const removed = Object.keys(cache.entries).filter((p) => !next[p]).length;
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify({ root, version: VERSION, entries: next }));
  } catch {
    /* cache write best-effort */
  }
  return { tracks, cached, scanned, removed };
}
