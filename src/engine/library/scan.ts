/**
 * Library scan — walk a real folder and read each file's tags into a flat Track list (the data the
 * Library grid and the stats are built from). Tag reads run with bounded concurrency for speed.
 */
import type { MediaFileRecord } from '../types.js';
import { walkToArray } from '../inventory/walk.js';
import { readTags } from '../inventory/tags.js';
import { stem } from '../text.js';

export interface Track extends MediaFileRecord {
  artist?: string;
  albumArtist?: string;
  album?: string;
  title: string;
  genre?: string;
  year?: number;
  trackNo?: number;
  discNo?: number;
  durationMs?: number;
  bitrateKbps?: number;
  lossless?: boolean;
}

export interface ScanLibraryOptions {
  limit?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

async function pmap<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, n), items.length || 1) }, worker));
  return out;
}

export async function scanLibrary(root: string, opts: ScanLibraryOptions = {}): Promise<Track[]> {
  const records = await walkToArray(root, { include: ['music'], ...(opts.limit ? { limit: opts.limit } : {}) });
  let done = 0;
  return pmap(records, opts.concurrency ?? 8, async (rec) => {
    const tags = await readTags(rec.path);
    opts.onProgress?.(++done, records.length);
    return { ...rec, ...tags, title: tags.title || stem(rec.name) };
  });
}
