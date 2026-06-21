/** String normalization helpers shared across parsing, clustering, and dedup. */

const AUDIO_EXTS = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma', 'aiff', 'alac', 'ape']);
const LOSSLESS_EXTS = new Set(['flac', 'wav', 'alac', 'aiff', 'ape']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'tiff']);
const VIDEO_EXTS = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'm4v', 'webm', 'mpg', 'mpeg']);

export function isAudioExt(ext: string): boolean {
  return AUDIO_EXTS.has(ext.toLowerCase());
}
export function isLosslessExt(ext: string): boolean {
  return LOSSLESS_EXTS.has(ext.toLowerCase());
}

export function mediaTypeForExt(ext: string): 'music' | 'image' | 'video' | 'other' {
  const e = ext.toLowerCase();
  if (AUDIO_EXTS.has(e)) return 'music';
  if (IMAGE_EXTS.has(e)) return 'image';
  if (VIDEO_EXTS.has(e)) return 'video';
  return 'other';
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** Strip the extension from a basename. */
export function stem(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(0, i) : name;
}

/** Collapse whitespace, drop most punctuation, lowercase — for fuzzy key comparison. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .replace(/[_]+/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove disc/volume/edition tokens so disc folders of one release collapse to a common key. */
export function stripDiscTokens(s: string): string {
  return s
    .replace(/\((?:cd|disc|disco|volume|vol)\s*\.?\s*\d+\)/gi, '')
    .replace(/\b(?:cd|disc|disco|volume|vol)\s*\.?\s*\d+\b/gi, '')
    .replace(/\bvolume\d+\b/gi, '')
    .replace(/\((?:remaster(?:ed|s)?|deluxe|expanded|reissue)[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A normalized title key for cross-album duplicate detection. Conservative: returns '' if too short. */
export function titleKey(rawTitle: string): string {
  let b = rawTitle.toLowerCase();
  b = b.replace(/\.[^.]+$/, '');
  b = b.replace(/\b(part|pt)\b.*$/i, '');
  b = b.replace(/\s*-\s*(edit|remix|live|remaster(?:ed)?|version|mix|mono|stereo)\b.*$/i, '');
  b = normalize(b);
  return b;
}

/** Detect a 4-digit year (1900-2099) anywhere in a string. */
export function findYear(s: string): number | undefined {
  const m = s.match(/\b(19[0-9]{2}|20[0-9]{2})\b/);
  return m ? Number(m[1]) : undefined;
}

export function humanBytes(b: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/**
 * Reject a track duration that implies a physically-impossible bitrate. Some real-world files make the
 * tag reader report absurd lengths — whole-CD `.ape` images and audiobook VBR MP3s with broken Xing
 * headers can claim hundreds or thousands of hours, which then poisons library-wide totals. Below ~4 kbps
 * no real audio exists, so such a duration is treated as bogus and dropped (returns undefined). File size
 * is the cross-check; it includes tag/container overhead, so the estimate is generous — we only drop the
 * truly impossible, never a legit long low-bitrate file (a 2 h, 57 MB audiobook is ~66 kbps and kept).
 */
export function plausibleDurationMs(durationMs: number | undefined, sizeBytes: number): number | undefined {
  if (durationMs == null || durationMs <= 0) return undefined;
  if (!(sizeBytes > 0)) return durationMs; // no size to validate against — trust the reader
  const impliedKbps = (sizeBytes * 8) / durationMs; // bytes*8 / ms === kbit/s
  return impliedKbps < 4 ? undefined : durationMs;
}
