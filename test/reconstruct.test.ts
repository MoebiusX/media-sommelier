import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseDirListing, reconstruct, parseName, sanitizeSegment } from '../src/engine/index.js';
import type { AlbumCandidate } from '../src/engine/index.js';

const FIXTURE = 'test/fixtures/real-world/car-playlists-selection.dir.txt';
const records = parseDirListing(readFileSync(FIXTURE, 'utf8'));
const report = reconstruct(records);

const byArtist = (needle: string): AlbumCandidate => {
  const c = report.candidates.find((x) => x.albumArtist.toLowerCase().includes(needle.toLowerCase()));
  if (!c) throw new Error(`no candidate for ${needle}`);
  return c;
};

describe('inventory import', () => {
  it('parses the Windows dir listing into audio records', () => {
    expect(report.summary.audioFiles).toBe(146);
    expect(report.summary.losslessRatio).toBe(0);
  });
});

describe('album reconstruction on the real sample', () => {
  it('produces one candidate per release (8 releases)', () => {
    expect(report.candidates.length).toBe(8);
  });

  it('MERGES Pink Floyd Echoes Cd1+Cd2 (sibling inline-marker folders) into one 2-disc release', () => {
    const pf = byArtist('pink floyd');
    expect(pf.discs.length).toBe(2);
    expect(pf.totalTracks).toBe(26);
    expect(pf.flags).toContain('multi-folder-merge');
    expect(pf.albumTitle.toLowerCase()).toContain('echoes');
  });

  it('MERGES Queen Greatest Hits I/II/III (dedicated-parent siblings) into one 3-disc box', () => {
    const q = byArtist('queen');
    expect(q.discs.length).toBe(3);
    expect(q.totalTracks).toBe(51);
  });

  it('MERGES Supertramp vol1+vol2 and flags lost track order', () => {
    const s = byArtist('supertramp');
    expect(s.totalTracks).toBe(29);
    expect(s.flags).toContain('multi-folder-merge');
    expect(s.flags).toContain('no-track-numbers');
  });

  it('reads disc/track from 3-digit prefixes and flags the partial Led Zeppelin disc set', () => {
    const lz = byArtist('led zeppelin');
    expect(lz.discs.map((d) => d.discNo)).toContain(2);
    expect(lz.flags).toContain('partial-disc-set');
  });

  it('detects orphaned single-track albums (Marc Antoine, The Eagles)', () => {
    expect(report.summary.orphans).toBe(2);
    expect(byArtist('marc antoine').flags).toContain('orphan');
    expect(byArtist('eagles').flags).toContain('orphan');
  });

  it('summary counts multi-disc releases', () => {
    expect(report.summary.multiDisc).toBe(3);
  });

  it('keeps confidence offline-capped at <= 0.75', () => {
    for (const c of report.candidates) expect(c.confidence).toBeLessThanOrEqual(0.75);
  });
});

describe('filename parsing', () => {
  it('parses disc+track underscore scheme', () => {
    const p = parseName('201-led_zeppelin-dazed_and_confused.mp3');
    expect(p.discNo).toBe(2);
    expect(p.trackNo).toBe(1);
    expect(p.artist).toBe('led zeppelin');
  });
  it('parses artist - (NN)title scheme', () => {
    const p = parseName('Pink Floyd - (05)Echoes.mp3');
    expect(p.trackNo).toBe(5);
    expect(p.title).toBe('Echoes');
  });
  it('parses no-track artist - title scheme', () => {
    const p = parseName('Supertramp - Rudy.mp3');
    expect(p.hasTrackNo).toBe(false);
    expect(p.title).toBe('Rudy');
  });
});

describe('organize path sanitization', () => {
  it('strips illegal characters and reserved names', () => {
    expect(sanitizeSegment('AC/DC: Back?')).toBe('AC DC Back');
    expect(sanitizeSegment('CON')).toBe('_CON');
  });
});
