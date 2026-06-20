/**
 * Photo scan via EXIF — the multi-media half of the original vision (apiserver's `exif` dep / photos.js).
 * Reads dimensions, capture time, camera, and GPS so photos can be browsed, grouped into events, and
 * (later) organized into a date tree. Pure-JS (exifr); no native deps.
 */
import exifr from 'exifr';
import type { MediaFileRecord } from '../types.js';
import { walkToArray } from '../inventory/walk.js';

export interface Photo extends MediaFileRecord {
  width?: number;
  height?: number;
  takenAt?: string;
  camera?: string;
  lens?: string;
  iso?: number;
  fNumber?: number;
  gpsLat?: number;
  gpsLon?: number;
}

const PICK = ['ExifImageWidth', 'ImageWidth', 'ExifImageHeight', 'ImageHeight', 'Make', 'Model', 'LensModel', 'ISO', 'FNumber', 'DateTimeOriginal', 'CreateDate', 'latitude', 'longitude'];

export async function readPhoto(path: string): Promise<Partial<Photo>> {
  try {
    const e = await exifr.parse(path, { gps: true, pick: PICK });
    if (!e) return {};
    const dt = e.DateTimeOriginal || e.CreateDate;
    return {
      ...(e.ExifImageWidth || e.ImageWidth ? { width: e.ExifImageWidth || e.ImageWidth } : {}),
      ...(e.ExifImageHeight || e.ImageHeight ? { height: e.ExifImageHeight || e.ImageHeight } : {}),
      ...(e.Make || e.Model ? { camera: [e.Make, e.Model].filter(Boolean).join(' ').trim() } : {}),
      ...(e.LensModel ? { lens: e.LensModel } : {}),
      ...(e.ISO ? { iso: Number(e.ISO) } : {}),
      ...(e.FNumber ? { fNumber: Number(e.FNumber) } : {}),
      ...(dt ? { takenAt: new Date(dt).toISOString() } : {}),
      ...(typeof e.latitude === 'number' ? { gpsLat: e.latitude } : {}),
      ...(typeof e.longitude === 'number' ? { gpsLon: e.longitude } : {}),
    };
  } catch {
    return {};
  }
}

export interface PhotoStats {
  count: number;
  bytes: number;
  withGps: number;
  withDate: number;
  cameras: Array<{ name: string; count: number }>;
  dateRange: { from?: string; to?: string };
}

export interface PhotoScanResult {
  photos: Photo[];
  stats: PhotoStats;
}

export async function scanPhotos(root: string, opts: { limit?: number; concurrency?: number } = {}): Promise<PhotoScanResult> {
  const records = await walkToArray(root, { include: ['image'], ...(opts.limit ? { limit: opts.limit } : {}) });
  const photos = new Array<Photo>(records.length);
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < records.length) {
      const i = idx++;
      const rec = records[i]!;
      photos[i] = { ...rec, ...(await readPhoto(rec.path)) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, opts.concurrency ?? 8), records.length || 1) }, worker));

  const cameras = new Map<string, number>();
  let bytes = 0, withGps = 0, withDate = 0;
  const dates: string[] = [];
  for (const p of photos) {
    bytes += p.sizeBytes;
    if (p.camera) cameras.set(p.camera, (cameras.get(p.camera) ?? 0) + 1);
    if (p.gpsLat != null) withGps++;
    if (p.takenAt) { withDate++; dates.push(p.takenAt); }
  }
  dates.sort();
  return {
    photos,
    stats: {
      count: photos.length,
      bytes,
      withGps,
      withDate,
      cameras: [...cameras.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
      dateRange: { ...(dates[0] ? { from: dates[0] } : {}), ...(dates.length ? { to: dates[dates.length - 1] } : {}) },
    },
  };
}
