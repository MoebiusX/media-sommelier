import { describe, it, expect } from 'vitest';
import { reconstruct, planOrganize } from '../src/engine/index.js';
import type { MediaFileRecord } from '../src/engine/index.js';

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
