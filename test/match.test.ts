import { describe, it, expect } from 'vitest';
import { selectBestRelease, scoreRelease } from '../src/engine/index.js';
import type { AlbumCandidate, MBRelease } from '../src/engine/index.js';

/** Network-free test of the matching scorer against fixture MusicBrainz release objects. */
const candidate = {
  id: 'led-zeppelin-the-songs-remains-the-same',
  albumArtist: 'Led Zeppelin',
  albumTitle: 'The Songs Remains The Same', // note the user's folder typo
  totalTracks: 15,
  discs: [],
  completeness: 1,
  confidence: 0.7,
  flags: [],
  evidence: [],
  schemes: [],
  sizeBytes: 0,
} as unknown as AlbumCandidate;

const releases: MBRelease[] = [
  {
    id: 'mbid-correct',
    title: 'The Song Remains the Same', // correctly spelled
    date: '2007-11-20',
    'track-count': 15,
    'artist-credit': [{ name: 'Led Zeppelin' }],
    'release-group': { id: 'rg-1', 'primary-type': 'Album' },
  },
  {
    id: 'mbid-wrong',
    title: 'Mothership',
    date: '2007-10-30',
    'track-count': 24,
    'artist-credit': [{ name: 'Led Zeppelin' }],
    'release-group': { id: 'rg-2', 'primary-type': 'Album' },
  },
];

describe('MusicBrainz match scoring', () => {
  it('picks the right release despite the title typo, using artist + track-count', () => {
    const best = selectBestRelease(candidate, releases);
    expect(best).not.toBeNull();
    expect(best!.release.id).toBe('mbid-correct');
  });

  it('scores a correct match higher than a same-artist wrong album', () => {
    const right = scoreRelease(candidate, releases[0]!).score;
    const wrong = scoreRelease(candidate, releases[1]!).score;
    expect(right).toBeGreaterThan(wrong);
  });

  it('returns null when nothing clears the threshold', () => {
    const junk: MBRelease[] = [{ id: 'x', title: 'Completely Different', 'track-count': 99, 'artist-credit': [{ name: 'Someone Else' }] }];
    expect(selectBestRelease(candidate, junk)).toBeNull();
  });
});
