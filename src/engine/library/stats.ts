/** Library statistics over a flat Track list — the MusicBee-style numbers, computed from real tags. */
import type { Track } from './scan.js';

export interface LibraryStats {
  tracks: number;
  albums: number;
  artists: number;
  genres: number;
  totalBytes: number;
  totalDurationMs: number;
  losslessRatio: number;
  formats: Record<string, number>;
  topArtists: Array<{ name: string; tracks: number }>;
  topGenres: Array<{ name: string; tracks: number }>;
  topYears: Array<{ year: number; tracks: number }>;
}

const top = (m: Map<string, number>, n: number): Array<{ name: string; tracks: number }> =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, tracks]) => ({ name, tracks }));

export function computeLibraryStats(tracks: Track[]): LibraryStats {
  const artists = new Map<string, number>();
  const genres = new Map<string, number>();
  const years = new Map<number, number>();
  const albums = new Set<string>();
  const formats: Record<string, number> = {};
  let bytes = 0;
  let durationMs = 0;
  let lossless = 0;

  for (const t of tracks) {
    const artist = t.albumArtist || t.artist;
    if (artist) artists.set(artist, (artists.get(artist) ?? 0) + 1);
    if (t.genre) genres.set(t.genre, (genres.get(t.genre) ?? 0) + 1);
    if (t.year) years.set(t.year, (years.get(t.year) ?? 0) + 1);
    if (t.album) albums.add(`${(artist || '').toLowerCase()}|${t.album.toLowerCase()}`);
    formats[t.ext] = (formats[t.ext] ?? 0) + 1;
    bytes += t.sizeBytes;
    durationMs += t.durationMs ?? 0;
    if (t.lossless) lossless++;
  }

  return {
    tracks: tracks.length,
    albums: albums.size,
    artists: artists.size,
    genres: genres.size,
    totalBytes: bytes,
    totalDurationMs: durationMs,
    losslessRatio: tracks.length ? lossless / tracks.length : 0,
    formats,
    topArtists: top(artists, 8),
    topGenres: top(genres, 8),
    topYears: [...years.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([year, tracks]) => ({ year, tracks })),
  };
}
