import { describe, it, expect } from 'vitest';
import { reconstruct, planOrganize, ORGANIZE_PRESETS } from '../src/engine/index.js';
import type { MediaFileRecord, AlbumEnrichment } from '../src/engine/index.js';

const dir = 'X:\\Music\\Pink Floyd - The Wall';
const mk = (name: string): MediaFileRecord => ({
  path: `${dir}\\${name}`,
  dir,
  name,
  ext: 'mp3',
  sizeBytes: 1000,
  mtime: '2024-01-01',
  mediaType: 'music',
});

describe('organize plan attaches corrected tags', () => {
  const report = reconstruct([mk('01 - In the Flesh.mp3'), mk('02 - The Thin Ice.mp3')]);
  const plan = planOrganize(report.candidates, { destRoot: 'D:/Out' });

  it('every action carries album/artist/track tags derived from reconstruction', () => {
    expect(plan.actions.length).toBe(2);
    const a = plan.actions[0]!;
    expect(a.tags.album).toBeTruthy();
    expect(a.tags.albumArtist).toBe('Pink Floyd');
    expect(a.tags.trackNo).toBe(1);
    expect(a.tags.discNo).toBe(1);
    expect(a.tags.title).toBe('In the Flesh');
  });

  it('destination path reflects the tags (Artist/Album/NN - Title)', () => {
    expect(plan.actions[0]!.destRelPath).toContain('Pink Floyd');
    expect(plan.actions[0]!.destRelPath).toContain('01 - In the Flesh');
  });
});

describe('organize plan honors MusicBrainz enrichment overrides', () => {
  const report = reconstruct([mk('01 - In the Flesh.mp3'), mk('02 - The Thin Ice.mp3')]);
  const cid = report.candidates[0]!.id;
  const enrichment = new Map<string, AlbumEnrichment>([
    [
      cid,
      {
        artist: 'Pink Floyd',
        album: 'The Wall',
        year: 1979,
        mbReleaseId: 'mbid-wall',
        mbReleaseGroupId: 'rg-wall',
        trackTitles: new Map([
          ['1:1', 'Another Brick in the Wall'],
          ['1:2', 'The Thin Ice'],
        ]),
      },
    ],
  ]);
  const plan = planOrganize(report.candidates, { destRoot: 'D:/Out', enrichment });

  it('drives tags from the enrichment (album/year/title/MBID)', () => {
    const a = plan.actions[0]!;
    expect(a.tags.album).toBe('The Wall');
    expect(a.tags.year).toBe(1979);
    expect(a.tags.title).toBe('Another Brick in the Wall'); // enriched, not the filename "In the Flesh"
    expect(a.tags.mbReleaseId).toBe('mbid-wall');
  });

  it('drives the destination path from the enrichment (canonical Year Album + title)', () => {
    expect(plan.actions[0]!.destRelPath).toContain('1979 The Wall');
    expect(plan.actions[0]!.destRelPath).toContain('01 - Another Brick in the Wall');
  });
});

describe('organize naming-scheme presets', () => {
  const report = reconstruct([mk('01 - In the Flesh.mp3'), mk('02 - The Thin Ice.mp3')]);

  it('flat preset puts the release in one segment (no subfolders)', () => {
    const p = planOrganize(report.candidates, { destRoot: 'D:/Out', template: ORGANIZE_PRESETS['flat']!.template });
    expect(p.actions[0]!.destRelPath.includes('/')).toBe(false);
    expect(p.actions[0]!.destRelPath).toContain('Pink Floyd - The Wall - 01 - In the Flesh');
  });

  it('artist-album preset omits the year folder', () => {
    const p = planOrganize(report.candidates, { destRoot: 'D:/Out', template: ORGANIZE_PRESETS['artist-album']!.template });
    expect(p.actions[0]!.destRelPath).toBe('Pink Floyd/The Wall/01 - In the Flesh.mp3');
  });
});
