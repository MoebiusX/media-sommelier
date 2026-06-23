import { describe, it, expect } from 'vitest';
import { groupByMetadata, metadataCandidates, planOrganize, type MetaTrack } from '../src/engine/index.js';

const t = (path: string, artist: string | null, album: string | null, trackNo: number | null, extra: Partial<MetaTrack> = {}): MetaTrack => ({
  path,
  artist,
  album,
  title: extra.title ?? `Track ${trackNo ?? '?'}`,
  trackNo,
  discNo: extra.discNo ?? null,
  year: extra.year ?? null,
});

describe('groupByMetadata', () => {
  it('integrates tracks that share an album tag across different folders', () => {
    const tracks: MetaTrack[] = [
      t('/music/rips/cd1/01.flac', 'Radiohead', 'OK Computer', 1, { year: 1997 }),
      t('/music/loose/okc-airbag.mp3', 'Radiohead', 'OK Computer', 2),
      t('/music/various/track.mp3', 'Radiohead', 'OK Computer', 3),
    ];
    const { albums, stats } = groupByMetadata(tracks);
    expect(albums).toHaveLength(1);
    const a = albums[0]!;
    expect(a.album).toBe('OK Computer');
    expect(a.trackCount).toBe(3);
    expect(a.folderCount).toBe(3);
    expect(a.integrated).toBe(true);
    expect(a.confidence).toBeLessThanOrEqual(0.75);
    expect(a.evidence.join(' ')).toMatch(/Integrates 3 tracks from 3 folders/);
    expect(stats.integratedAlbums).toBe(1);
    expect(stats.integratedTracks).toBe(3);
  });

  it('does NOT mark a single-folder album as integrated', () => {
    const tracks: MetaTrack[] = [
      t('/music/Beatles/Revolver/01.flac', 'The Beatles', 'Revolver', 1),
      t('/music/Beatles/Revolver/02.flac', 'The Beatles', 'Revolver', 2),
    ];
    const a = groupByMetadata(tracks).albums[0]!;
    expect(a.integrated).toBe(false);
    expect(a.folderCount).toBe(1);
  });

  it('merges disc/volume variants of the same release (stripDiscTokens)', () => {
    const tracks: MetaTrack[] = [
      t('/m/a/CD1/01.flac', 'Pink Floyd', 'The Wall (CD1)', 1, { discNo: 1 }),
      t('/m/a/CD2/01.flac', 'Pink Floyd', 'The Wall (CD2)', 1, { discNo: 2 }),
    ];
    const { albums } = groupByMetadata(tracks);
    expect(albums).toHaveLength(1);
    expect(albums[0]!.discCount).toBe(2);
    expect(albums[0]!.integrated).toBe(true);
  });

  it('counts untagged (no album) tracks instead of grouping them', () => {
    const tracks: MetaTrack[] = [t('/m/loose.mp3', 'Someone', null, null), t('/m/ok/01.flac', 'A', 'B', 1)];
    const { stats } = groupByMetadata(tracks);
    expect(stats.untaggedTracks).toBe(1);
    expect(stats.placedTracks).toBe(1);
    expect(stats.albums).toBe(1);
  });
});

describe('metadataCandidates → planOrganize', () => {
  it('routes scattered same-album tracks into one album folder, collision-free', () => {
    const tracks: MetaTrack[] = [
      t('/m/a/01.flac', 'NSYNC', 'No Strings Attached', 1, { title: 'Bye Bye Bye' }),
      t('/m/loose/x.mp3', 'NSYNC', 'No Strings Attached', 2, { title: "It's Gonna Be Me" }),
      t('/m/various/y.mp3', 'NSYNC', 'No Strings Attached', null, { title: 'Space Cowboy' }), // no trackNo
    ];
    const cands = metadataCandidates(tracks);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.confidence).toBeLessThanOrEqual(0.75);

    const plan = planOrganize(cands, { destRoot: 'OUT', template: '{albumArtist}/{album}/{track} - {title}' });
    expect(plan.actions).toHaveLength(3);
    expect(plan.collisions).toHaveLength(0);
    // all three land under the same album folder
    const albumFolders = new Set(plan.actions.map((a) => a.destRelPath.split('/').slice(0, 2).join('/')));
    expect(albumFolders.size).toBe(1);
    expect([...albumFolders][0]).toMatch(/NSYNC\/No Strings Attached/);
    // tracks 1 & 2 keep their number; the untagged one takes the next free slot (3)
    expect(plan.actions.map((a) => a.tags.trackNo).sort((x, y) => x - y)).toEqual([1, 2, 3]);
  });

  it('keeps multi-disc albums collision-free across discs', () => {
    const tracks: MetaTrack[] = [
      t('/m/cd1/01.flac', 'X', 'Y', 1, { discNo: 1 }),
      t('/m/cd2/01.flac', 'X', 'Y', 1, { discNo: 2 }),
    ];
    const cands = metadataCandidates(tracks);
    expect(cands[0]!.discs).toHaveLength(2);
    expect(planOrganize(cands, { destRoot: 'OUT' }).collisions).toHaveLength(0);
  });
});
