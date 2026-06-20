import { describe, it, expect } from 'vitest';
import { reconstruct } from '../src/engine/index.js';
import type { MediaFileRecord, AlbumCandidate } from '../src/engine/index.js';

const file = (dir: string, name: string): MediaFileRecord => ({
  path: `${dir}\\${name}`,
  dir,
  name,
  ext: 'mp3',
  sizeBytes: 1000,
  mtime: '2024-01-01',
  mediaType: 'music',
});

const byArtist = (cands: AlbumCandidate[], needle: string) =>
  cands.find((c) => c.albumArtist.toLowerCase().includes(needle.toLowerCase()))!;

describe('reconstruction flags & signals', () => {
  it('flags possible-compilation for greatest-hits folders', () => {
    const dir = 'M\\Queen - Greatest Hits';
    const r = reconstruct([file(dir, '01 - Bohemian Rhapsody.mp3'), file(dir, '02 - Killer Queen.mp3')]);
    expect(r.candidates[0]!.flags).toContain('possible-compilation');
  });

  it('flags no-track-numbers and still groups the folder', () => {
    const dir = 'M\\Supertramp - Hits';
    const r = reconstruct([file(dir, 'Supertramp - Dreamer.mp3'), file(dir, 'Supertramp - Rudy.mp3')]);
    expect(r.candidates[0]!.flags).toContain('no-track-numbers');
    expect(r.candidates[0]!.totalTracks).toBe(2);
  });

  it('estimates completeness from gaps in track numbers', () => {
    const dir = 'M\\Artist - Album';
    const r = reconstruct([file(dir, '01 - A.mp3'), file(dir, '02 - B.mp3'), file(dir, '05 - E.mp3')]);
    expect(r.candidates[0]!.completeness).toBeCloseTo(0.6, 2); // 3 present of max-track 5
  });

  it('flags a partial disc set (only disc 2 present)', () => {
    const dir = 'M\\Led Zeppelin - Live (2CD)\\CD 2';
    const r = reconstruct([file(dir, '201-led_zeppelin-dazed.mp3'), file(dir, '202-led_zeppelin-stairway.mp3')]);
    const c = r.candidates[0]!;
    expect(c.discs.map((d) => d.discNo)).toEqual([2]);
    expect(c.flags).toContain('partial-disc-set');
  });

  it('detects multi-word duplicate titles across different candidates', () => {
    const r = reconstruct([
      file('M\\Eagles - Greatest', '01 - Hotel California.mp3'),
      file('M\\Eagles - Greatest', '02 - Take It Easy.mp3'),
      file('M\\Various - Road Mix', '03 - Hotel California.mp3'),
      file('M\\Various - Road Mix', '04 - Something Else.mp3'),
    ]);
    const dup = r.duplicates.find((d) => d.titleKey === 'hotel california');
    expect(dup).toBeDefined();
    expect(dup!.occurrences.length).toBe(2);
  });

  it('does NOT flag single-word titles as duplicates (noise guard)', () => {
    const r = reconstruct([
      file('M\\A - One', '01 - Money.mp3'),
      file('M\\B - Two', '01 - Money.mp3'),
    ]);
    expect(r.duplicates.find((d) => d.titleKey === 'money')).toBeUndefined();
  });
});
