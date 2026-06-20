import { describe, it, expect } from 'vitest';
import { enrichCandidate } from '../src/engine/index.js';
import type { AlbumCandidate, MusicBrainzClient, AcoustIdClient } from '../src/engine/index.js';

function candidate(over: Partial<AlbumCandidate> = {}): AlbumCandidate {
  return {
    id: 'c1',
    albumArtist: 'Pink Floyd',
    albumTitle: 'Echoes',
    totalTracks: 2,
    discs: [
      {
        discNo: 1,
        sourceDirs: ['/x'],
        maxTrackNo: 2,
        tracks: [
          { file: { path: '/x/01.mp3', dir: '/x', name: '01.mp3', ext: 'mp3', sizeBytes: 1, mtime: '2024-01-01', mediaType: 'music' }, parsed: { scheme: 's', hasTrackNo: true }, discNo: 1, position: 1, title: 'A' },
        ],
      },
    ],
    completeness: 1,
    confidence: 0.7,
    flags: [],
    evidence: [],
    schemes: [],
    sizeBytes: 1,
    ...over,
  } as AlbumCandidate;
}

const matchingRelease = { id: 'r1', title: 'Echoes', 'track-count': 2, date: '2001-11-05', 'artist-credit': [{ name: 'Pink Floyd' }], 'release-group': { id: 'rg1', 'primary-type': 'Album' } };

describe('enrichCandidate', () => {
  it('matches via MusicBrainz tags and extracts the year', async () => {
    const mb = { searchReleases: async () => [matchingRelease] } as unknown as MusicBrainzClient;
    const e = await enrichCandidate(candidate(), { mb });
    expect(e.status).toBe('matched');
    expect(e.via).toBe('mb-tags');
    expect(e.match?.year).toBe(2001);
    expect(e.match?.album).toBe('Echoes');
  });

  it('fetches the tracklist when asked', async () => {
    const mb = {
      searchReleases: async () => [matchingRelease],
      getRelease: async () => ({ id: 'r1', title: 'Echoes', media: [{ position: 1, tracks: [{ position: 1, title: 'Astronomy Domine' }] }] }),
    } as unknown as MusicBrainzClient;
    const e = await enrichCandidate(candidate(), { mb, fetchTracklist: true });
    expect(e.match?.tracklist).toHaveLength(1);
    expect(e.match?.tracklist?.[0]?.title).toBe('Astronomy Domine');
  });

  it('falls back to AcoustID to recover the artist, then re-queries MB', async () => {
    // tags say "Jefferson"; MB only matches once AcoustID reveals "Jefferson Airplane"
    const mb = {
      searchReleases: async (artist: string) =>
        artist === 'Jefferson Airplane' ? [{ id: 'r2', title: 'The Essential', 'track-count': 2, 'artist-credit': [{ name: 'Jefferson Airplane' }] }] : [],
    } as unknown as MusicBrainzClient;
    const acoustid = {
      hasKey: () => true,
      lookup: async () => ({ ok: true, matchCount: 1, best: { acoustId: 'a', score: 0.9, artist: 'Jefferson Airplane' } }),
    } as unknown as AcoustIdClient;
    const e = await enrichCandidate(candidate({ albumArtist: 'Jefferson', albumTitle: 'The Essential' }), {
      mb,
      acoustid,
      fingerprintFallback: true,
      fingerprintFn: async () => ({ duration: 100, fingerprint: 'Z' }),
    });
    expect(e.status).toBe('matched');
    expect(e.via).toBe('acoustid+mb');
    expect(e.match?.artist).toBe('Jefferson Airplane');
  });

  it('returns no-match when MB misses and no fallback is enabled', async () => {
    const mb = { searchReleases: async () => [] } as unknown as MusicBrainzClient;
    const e = await enrichCandidate(candidate(), { mb });
    expect(e.status).toBe('no-match');
    expect(e.match).toBeUndefined();
  });

  it('does not fingerprint when the AcoustID key is missing', async () => {
    let fpCalls = 0;
    const mb = { searchReleases: async () => [] } as unknown as MusicBrainzClient;
    const acoustid = { hasKey: () => false, lookup: async () => ({ ok: false, matchCount: 0 }) } as unknown as AcoustIdClient;
    const e = await enrichCandidate(candidate(), {
      mb,
      acoustid,
      fingerprintFallback: true,
      fingerprintFn: async () => {
        fpCalls++;
        return { duration: 1, fingerprint: 'x' };
      },
    });
    expect(e.status).toBe('no-match');
    expect(fpCalls).toBe(0);
  });
});
