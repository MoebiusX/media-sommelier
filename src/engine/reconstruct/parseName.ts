/**
 * Parse an audio filename into musical parts across the naming schemes seen in real collections.
 *
 * Track/disc NUMBERS are the high-value extraction (used for ordering + completeness) and are robust.
 * Artist/title are best-effort here; the reconstruction layer refines the title using folder-level
 * album-artist context (e.g. stripping a leading "ARTIST - " that this function can't disambiguate).
 */
import type { ParsedName } from '../types.js';
import { stem } from '../text.js';

function num(s: string | undefined): number | undefined {
  if (s == null) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function parseName(filename: string): ParsedName {
  const s = stem(filename).trim();

  // Scheme 1: "101-led_zeppelin-rock_and_roll" → disc(1) track(01) artist title, underscores.
  let m = s.match(/^([1-9])(\d{2})-([^-]+?)-(.+)$/);
  if (m) {
    return {
      discNo: num(m[1]),
      trackNo: num(m[2]),
      artist: deunderscore(m[3]!),
      title: deunderscore(m[4]!),
      scheme: 'discTrack_artist_title',
      hasTrackNo: true,
    };
  }

  // Scheme 3: "Pink Floyd - (05)Echoes" → artist - (NN)Title
  m = s.match(/^(.+?)\s*-\s*\((\d{1,2})\)\s*(.+)$/);
  if (m) {
    return {
      artist: m[1]!.trim(),
      trackNo: num(m[2]),
      title: m[3]!.trim(),
      scheme: 'artist_(NN)title',
      hasTrackNo: true,
    };
  }

  // Leading track number: "01 - Title", "01-Title", "01. Title", "01 - ARTIST - Title".
  m = s.match(/^(\d{1,3})\s*[-._)]\s*(.+)$/);
  if (m) {
    const track = num(m[1]);
    return {
      trackNo: track,
      title: m[2]!.trim(), // refined later (may be "ARTIST - Title")
      scheme: 'track_rest',
      hasTrackNo: track != null,
    };
  }

  // "Artist - Title" with no track number: "Supertramp - Rudy"
  m = s.match(/^(.+?)\s+-\s+(.+)$/);
  if (m) {
    return {
      artist: m[1]!.trim(),
      title: m[2]!.trim(),
      scheme: 'artist_title_notrack',
      hasTrackNo: false,
    };
  }

  return { title: s, scheme: 'unknown', hasTrackNo: false };
}

function deunderscore(s: string): string {
  return s.replace(/_/g, ' ').trim();
}
