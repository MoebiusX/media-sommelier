/**
 * Pure release-matching scorer (no I/O) — picks the MusicBrainz release that best matches a
 * reconstructed candidate, by title + artist similarity and track-count proximity. Unit-tested
 * against fixture MB responses; the network client feeds it but isn't required to test it.
 */
import type { AlbumCandidate } from '../types.js';
import { normalize } from '../text.js';
import type { MBRelease } from './musicbrainz.js';

export interface MatchResult {
  release: MBRelease;
  score: number;
  breakdown: { title: number; artist: number; tracks: number };
}

/** Dice coefficient over word sets — robust to ordering and minor extra words. */
function wordDice(a: string, b: string): number {
  const A = new Set(normalize(a).split(' ').filter(Boolean));
  const B = new Set(normalize(b).split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export function artistCreditName(r: MBRelease): string {
  if (!r['artist-credit']?.length) return '';
  return r['artist-credit'].map((c) => c.name + (c.joinphrase ?? '')).join('').trim();
}

export function scoreRelease(candidate: AlbumCandidate, r: MBRelease): MatchResult {
  const title = wordDice(candidate.albumTitle, r.title);
  const artist = wordDice(candidate.albumArtist, artistCreditName(r));
  const tc = r['track-count'] ?? 0;
  const delta = tc > 0 ? Math.abs(candidate.totalTracks - tc) : 99;
  const tracks = 1 / (1 + delta);
  const score = 0.45 * title + 0.35 * artist + 0.2 * tracks;
  return { release: r, score, breakdown: { title, artist, tracks } };
}

/** Best match above `threshold`, or null. */
export function selectBestRelease(candidate: AlbumCandidate, releases: MBRelease[], threshold = 0.5): MatchResult | null {
  let best: MatchResult | null = null;
  for (const r of releases) {
    const m = scoreRelease(candidate, r);
    if (!best || m.score > best.score) best = m;
  }
  return best && best.score >= threshold ? best : null;
}
