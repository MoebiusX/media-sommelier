import { describe, it, expect } from 'vitest';
import { computeLibraryStats } from '../src/engine/index.js';
import type { Track } from '../src/engine/index.js';

const t = (over: Partial<Track>): Track => ({
  path: 'p', dir: 'd', name: 'n.mp3', ext: 'mp3', sizeBytes: 1000, mtime: '2024-01-01', mediaType: 'music', title: 'T', ...over,
});

describe('computeLibraryStats', () => {
  const tracks = [
    t({ artist: 'Queen', album: 'A Night at the Opera', genre: 'Rock', year: 1975, durationMs: 300000, sizeBytes: 5_000_000, lossless: false, ext: 'mp3' }),
    t({ artist: 'Queen', album: 'A Night at the Opera', genre: 'Rock', year: 1975, durationMs: 200000, sizeBytes: 4_000_000, ext: 'mp3' }),
    t({ artist: 'Miles Davis', album: 'Kind of Blue', genre: 'Jazz', year: 1959, durationMs: 360000, sizeBytes: 30_000_000, lossless: true, ext: 'flac' }),
  ];
  const s = computeLibraryStats(tracks);

  it('counts tracks, albums, artists, genres distinctly', () => {
    expect(s.tracks).toBe(3);
    expect(s.albums).toBe(2);
    expect(s.artists).toBe(2);
    expect(s.genres).toBe(2);
  });

  it('sums bytes + duration and computes lossless ratio + formats', () => {
    expect(s.totalBytes).toBe(39_000_000);
    expect(s.totalDurationMs).toBe(860000);
    expect(s.losslessRatio).toBeCloseTo(1 / 3, 2);
    expect(s.formats.mp3).toBe(2);
    expect(s.formats.flac).toBe(1);
  });

  it('ranks top artists / genres / years', () => {
    expect(s.topArtists[0]).toEqual({ name: 'Queen', tracks: 2 });
    expect(s.topGenres.find((g) => g.name === 'Rock')!.tracks).toBe(2);
    expect(s.topYears[0]).toEqual({ year: 1975, tracks: 2 });
  });
});
