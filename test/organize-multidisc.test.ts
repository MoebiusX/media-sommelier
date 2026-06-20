import { describe, it, expect } from 'vitest';
import { reconstruct, planOrganize } from '../src/engine/index.js';
import type { MediaFileRecord, AlbumEnrichment, AlbumCandidate, DiscGroup } from '../src/engine/index.js';

/**
 * Regression: a multi-disc release whose source layout matches none of the merge strategies gets
 * reconstructed as a SINGLE disc. The two discs both restart track numbering at 1, so disc-1 track 01
 * and disc-2 track 01 produced the same destination path → execute.ts failed both as a collision.
 *
 * Fix: planOrganize recovers the real disc layout — from the authoritative MusicBrainz tracklist when
 * enrichment is active, and from track-number-reset detection as an offline fallback.
 */

const dir = 'R:\\Music\\Led Zeppelin - BBC Sessions';
const mk = (name: string): MediaFileRecord => ({
  path: `${dir}\\${name}`,
  dir,
  name,
  ext: 'mp3',
  sizeBytes: 1000,
  mtime: '2024-01-01',
  mediaType: 'music',
});

// A single folder holding TWO discs, both numbered from 01 — the real failure mode. After a filename
// sort the two discs interleave, and "Communication Breakdown" appears on BOTH discs (a live album).
const SINGLE_FOLDER_TWO_DISCS = [
  mk('01 - Communication Breakdown.mp3'), // disc 1, pos 1
  mk('02 - I Cant Quit You Baby.mp3'), //     disc 1, pos 2
  mk('03 - Dazed and Confused.mp3'), //       disc 1, pos 3
  mk('01 - The Girl I Love.mp3'), //          disc 2, pos 1
  mk('02 - Whole Lotta Love.mp3'), //         disc 2, pos 2
  mk('03 - Communication Breakdown.mp3'), //  disc 2, pos 3 (title repeats across discs)
];

// What MusicBrainz returns for the matched release: the authoritative two-disc structure.
const MB_TRACKLIST = [
  { disc: 1, position: 1, title: 'Communication Breakdown' },
  { disc: 1, position: 2, title: "I Can't Quit You Baby" },
  { disc: 1, position: 3, title: 'Dazed and Confused' },
  { disc: 2, position: 1, title: 'The Girl I Love' },
  { disc: 2, position: 2, title: 'Whole Lotta Love' },
  { disc: 2, position: 3, title: 'Communication Breakdown' },
];

function enrichmentFor(id: string): Map<string, AlbumEnrichment> {
  const trackTitles = new Map<string, string>();
  for (const t of MB_TRACKLIST) trackTitles.set(`${t.disc}:${t.position}`, t.title);
  return new Map([[id, { artist: 'Led Zeppelin', album: 'BBC Sessions', year: 1997, trackTitles, tracklist: MB_TRACKLIST }]]);
}

describe('multi-disc collapse — the reconstruction bug exists', () => {
  it('reconstructs the single folder as ONE disc with duplicate (disc, position) slots', () => {
    const report = reconstruct(SINGLE_FOLDER_TWO_DISCS);
    const c = report.candidates[0]!;
    expect(c.discs.length).toBe(1);
    const positions = c.discs[0]!.tracks.map((t) => t.position).sort((a, b) => a - b);
    expect(positions).toEqual([1, 1, 2, 2, 3, 3]); // both discs numbered 1..3
  });

  it('without the fix this would collide: 6 sources → 3 destination paths', () => {
    const report = reconstruct(SINGLE_FOLDER_TWO_DISCS);
    // Plain plan (no enrichment, no offline split) would map all six onto "01/02/03 - …".
    // We assert the fix instead avoids that below; here we just confirm the collapsed shape.
    expect(report.candidates[0]!.totalTracks).toBe(6);
  });
});

describe('enrichment-driven disc recovery', () => {
  const report = reconstruct(SINGLE_FOLDER_TWO_DISCS);
  const id = report.candidates[0]!.id;
  const plan = planOrganize(report.candidates, { destRoot: 'D:/Out', enrichment: enrichmentFor(id) });

  it('produces zero destination collisions', () => {
    expect(plan.collisions).toEqual([]);
    expect(plan.actions.length).toBe(6);
  });

  it('splits into Disc 1/ and Disc 2/ folders', () => {
    const discFolders = new Set(plan.actions.map((a) => a.destRelPath.match(/Disc \d/)?.[0]));
    expect([...discFolders].sort()).toEqual(['Disc 1', 'Disc 2']);
    expect(plan.actions.filter((a) => a.destRelPath.includes('Disc 1')).length).toBe(3);
    expect(plan.actions.filter((a) => a.destRelPath.includes('Disc 2')).length).toBe(3);
  });

  it('routes each source file onto the right disc using the authoritative tracklist', () => {
    const bySource = new Map(plan.actions.map((a) => [a.sourcePath, a]));
    const d1 = bySource.get(`${dir}\\02 - I Cant Quit You Baby.mp3`)!;
    expect(d1.tags.discNo).toBe(1);
    expect(d1.tags.discCount).toBe(2);
    expect(d1.tags.title).toBe("I Can't Quit You Baby"); // canonical title from MB
    expect(d1.destRelPath).toContain('Disc 1');

    const d2 = bySource.get(`${dir}\\02 - Whole Lotta Love.mp3`)!;
    expect(d2.tags.discNo).toBe(2);
    expect(d2.destRelPath).toContain('Disc 2');
  });

  it('resolves the title that appears on both discs to distinct slots (no collision)', () => {
    const comm = plan.actions.filter((a) => a.tags.title === 'Communication Breakdown');
    expect(comm.length).toBe(2);
    const slots = comm.map((a) => `${a.tags.discNo}:${a.tags.trackNo}`).sort();
    expect(slots).toEqual(['1:1', '2:3']);
  });
});

describe('offline disc recovery (no enrichment) — reset detection', () => {
  // Hand-built collapsed candidate: one disc, positions reset (1,2 then 1,2), filenames sort contiguously.
  const slot = (name: string, position: number): DiscGroup['tracks'][number] => ({
    file: { path: `${dir}\\${name}`, dir, name, ext: 'mp3', sizeBytes: 1000, mtime: '2024-01-01', mediaType: 'music' },
    parsed: { trackNo: position, scheme: 'track_rest', hasTrackNo: true },
    discNo: 1,
    position,
    title: name.replace(/\.mp3$/, ''),
  });
  const candidate: AlbumCandidate = {
    id: 'two-disc-collapsed',
    albumArtist: 'Test Artist',
    albumTitle: 'Live Set',
    discs: [
      {
        discNo: 1,
        sourceDirs: [dir],
        maxTrackNo: 2,
        tracks: [slot('a1 - One.mp3', 1), slot('a2 - Two.mp3', 2), slot('b1 - Three.mp3', 1), slot('b2 - Four.mp3', 2)],
      },
    ],
    totalTracks: 4,
    completeness: 1,
    confidence: 0.6,
    flags: [],
    evidence: [],
    schemes: ['track_rest'],
    sizeBytes: 4000,
  };

  const plan = planOrganize([candidate], { destRoot: 'D:/Out' });

  it('splits the reset into two discs with no collisions', () => {
    expect(plan.collisions).toEqual([]);
    const discFolders = new Set(plan.actions.map((a) => a.destRelPath.match(/Disc \d/)?.[0]));
    expect([...discFolders].sort()).toEqual(['Disc 1', 'Disc 2']);
    expect(plan.actions.map((a) => a.tags.discCount)).toEqual([2, 2, 2, 2]);
  });
});

describe('no regression: a correctly reconstructed multi-disc release is left intact', () => {
  // in-folder 1xx/2xx scheme — already detected as two discs; enrichment must NOT re-mangle it.
  const d = 'R:\\Music\\Led Zeppelin - Live (2CD)';
  const f = (name: string): MediaFileRecord => ({ path: `${d}\\${name}`, dir: d, name, ext: 'mp3', sizeBytes: 1000, mtime: '2024-01-01', mediaType: 'music' });
  const report = reconstruct([
    f('101-led_zeppelin-rock_and_roll.mp3'),
    f('102-led_zeppelin-black_dog.mp3'),
    f('201-led_zeppelin-kashmir.mp3'),
  ]);

  it('keeps both discs and stays collision-free', () => {
    const c = report.candidates[0]!;
    expect(c.discs.map((x) => x.discNo)).toEqual([1, 2]);
    const tl = [
      { disc: 1, position: 1, title: 'Rock and Roll' },
      { disc: 1, position: 2, title: 'Black Dog' },
      { disc: 2, position: 1, title: 'Kashmir' },
    ];
    const trackTitles = new Map(tl.map((t) => [`${t.disc}:${t.position}`, t.title]));
    const enrichment = new Map<string, AlbumEnrichment>([[c.id, { trackTitles, tracklist: tl }]]);
    const plan = planOrganize(report.candidates, { destRoot: 'D:/Out', enrichment });
    expect(plan.collisions).toEqual([]);
    expect(plan.actions.filter((a) => a.destRelPath.includes('Disc 1')).length).toBe(2);
    expect(plan.actions.filter((a) => a.destRelPath.includes('Disc 2')).length).toBe(1);
  });
});
