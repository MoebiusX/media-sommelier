/**
 * Metadata-based album reconstruction. The folder reconstruct() groups files by WHERE they live; this
 * groups by what their TAGS say — pulling every track that shares an (album-artist, album) tag into one
 * album, even when those tracks are scattered across different folders. The payoff is "integrated"
 * albums: releases the folder layout had fragmented, made whole again from embedded metadata.
 *
 * Pure (no IO): the caller supplies tag-level tracks (e.g. the indexed catalog). Offline, I3-safe. Tag
 * grouping is heuristic, so confidence is capped ≤ 0.75 (I4) and every album carries an evidence trace.
 */
import { normalize, stripDiscTokens } from '../text.js';
import type { AlbumCandidate, CandidateFlag, DiscGroup, MediaFileRecord, ParsedName, TrackSlot } from '../types.js';

export interface MetaTrack {
  path: string;
  artist: string | null; // album-artist (preferred) or track artist
  album: string | null;
  title: string | null;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  sizeBytes?: number | null;
}

export interface MetaAlbumTrack {
  path: string;
  title: string;
  trackNo: number | null;
  discNo: number | null;
  folder: string; // source folder basename
}

export interface MetaAlbum {
  key: string;
  album: string;
  artist: string;
  year: number | null;
  trackCount: number;
  discCount: number;
  folders: string[]; // distinct source-folder basenames (capped for display)
  folderCount: number;
  /** True when the album's tracks span more than one source folder — folders had it scattered. */
  integrated: boolean;
  confidence: number; // ≤ 0.75 (I4)
  evidence: string[];
  sampleTracks: MetaAlbumTrack[];
}

export interface MetadataGrouping {
  albums: MetaAlbum[];
  stats: {
    totalTracks: number;
    placedTracks: number;
    untaggedTracks: number; // no album tag → can't be placed
    albums: number;
    multiTrackAlbums: number;
    integratedAlbums: number;
    integratedTracks: number;
    singletonAlbums: number;
  };
}

/** Directory of a path, handling both / and \ separators (source paths may be Windows). */
function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(0, i) : '';
}
function baseName(dir: string): string {
  const i = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
  return i >= 0 ? dir.slice(i + 1) : dir;
}

interface Bucket {
  album: string;
  artist: string;
  year: number | null;
  tracks: Array<{ t: MetaTrack; folder: string }>;
  folders: Set<string>;
  discs: Set<number>;
}

/** Bucket tracks by their normalized (album-artist, album) key; returns the groups + untagged count. */
function bucketize(tracks: MetaTrack[]): { buckets: Map<string, Bucket>; untagged: number } {
  const buckets = new Map<string, Bucket>();
  let untagged = 0;
  for (const t of tracks) {
    const album = (t.album ?? '').trim();
    if (!album) {
      untagged++;
      continue;
    }
    const artist = (t.artist ?? '').trim();
    // strip disc/volume tokens so "Album (CD1)" + "Album (CD2)" collapse into one release
    const key = normalize(artist) + '|' + normalize(stripDiscTokens(album));
    let b = buckets.get(key);
    if (!b) {
      b = { album, artist: artist || 'Unknown Artist', year: t.year, tracks: [], folders: new Set(), discs: new Set() };
      buckets.set(key, b);
    }
    const folder = dirOf(t.path);
    b.tracks.push({ t, folder });
    b.folders.add(folder);
    if (t.discNo != null) b.discs.add(t.discNo);
    if (b.year == null && t.year != null) b.year = t.year;
  }
  return { buckets, untagged };
}

/** Group tag-level tracks into albums by their (album-artist, album) metadata. */
export function groupByMetadata(tracks: MetaTrack[]): MetadataGrouping {
  const { buckets, untagged } = bucketize(tracks);

  const albums: MetaAlbum[] = [];
  let multiTrack = 0;
  let integrated = 0;
  let integratedTracks = 0;
  let singleton = 0;
  let placed = 0;

  for (const [key, b] of buckets) {
    placed += b.tracks.length;
    const folderCount = b.folders.size;
    const isIntegrated = folderCount > 1;
    if (b.tracks.length > 1) multiTrack++;
    else singleton++;
    if (isIntegrated) {
      integrated++;
      integratedTracks += b.tracks.length;
    }
    const sorted = [...b.tracks].sort(
      (a, z) =>
        (a.t.discNo ?? 1) - (z.t.discNo ?? 1) ||
        (a.t.trackNo ?? 9999) - (z.t.trackNo ?? 9999) ||
        (a.t.title ?? '').localeCompare(z.t.title ?? ''),
    );
    // Tag-grouped → heuristic; cap at 0.75 (I4). A multi-track group is more trustworthy than a singleton.
    const confidence =
      b.tracks.length === 1 ? 0.4 : Math.min(0.75, 0.6 + Math.min(0.15, b.tracks.length * 0.01));
    const evidence: string[] = [`Grouped by album tag “${b.album}”`, `Album-artist “${b.artist}”`];
    if (isIntegrated) evidence.push(`Integrates ${b.tracks.length} tracks from ${folderCount} folders`);
    if (b.discs.size > 1) evidence.push(`${b.discs.size} discs`);

    albums.push({
      key,
      album: b.album,
      artist: b.artist,
      year: b.year,
      trackCount: b.tracks.length,
      discCount: Math.max(1, b.discs.size),
      folders: [...b.folders].map(baseName).slice(0, 6),
      folderCount,
      integrated: isIntegrated,
      confidence,
      evidence,
      sampleTracks: sorted.slice(0, 8).map((s) => ({
        path: s.t.path,
        title: s.t.title ?? '',
        trackNo: s.t.trackNo,
        discNo: s.t.discNo,
        folder: baseName(s.folder),
      })),
    });
  }

  // integrated albums first (most folders, then most tracks) — the "album integration" payoff up top
  albums.sort(
    (a, z) =>
      Number(z.integrated) - Number(a.integrated) ||
      z.folderCount - a.folderCount ||
      z.trackCount - a.trackCount ||
      a.album.localeCompare(z.album),
  );

  return {
    albums,
    stats: {
      totalTracks: tracks.length,
      placedTracks: placed,
      untaggedTracks: untagged,
      albums: buckets.size,
      multiTrackAlbums: multiTrack,
      integratedAlbums: integrated,
      integratedTracks,
      singletonAlbums: singleton,
    },
  };
}

/** Build a synthetic MediaFileRecord from a track path (no stat — we only need path/name/ext for planning). */
function fileRecordFor(t: MetaTrack): MediaFileRecord {
  const path = t.path;
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dir = slash >= 0 ? path.slice(0, slash) : '';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return { path, dir, name, ext, sizeBytes: t.sizeBytes ?? 0, mtime: '', mediaType: 'music' };
}

/**
 * Turn the metadata grouping into AlbumCandidate[] the organize planner consumes — so the catalog can be
 * REORGANIZED by tags (not just simulated). Disc positions are allocated collision-free: a track keeps its
 * real trackNo when it's present and free on that disc, else it takes the next open slot. Confidence is
 * capped ≤ 0.75 (I4); cross-folder albums are flagged 'multi-folder-merge' with an evidence trace.
 */
export function metadataCandidates(tracks: MetaTrack[]): AlbumCandidate[] {
  const { buckets } = bucketize(tracks);
  const out: AlbumCandidate[] = [];
  let n = 0;

  for (const [key, b] of buckets) {
    const byDisc = new Map<number, MetaTrack[]>();
    for (const { t } of b.tracks) {
      const d = t.discNo ?? 1;
      if (!byDisc.has(d)) byDisc.set(d, []);
      byDisc.get(d)!.push(t);
    }

    const discs: DiscGroup[] = [];
    for (const [discNo, items] of [...byDisc.entries()].sort((a, z) => a[0] - z[0])) {
      items.sort(
        (a, z) =>
          (a.trackNo ?? 1e9) - (z.trackNo ?? 1e9) ||
          (a.title ?? '').localeCompare(z.title ?? '') ||
          a.path.localeCompare(z.path),
      );
      const used = new Set<number>();
      let nextFree = 1;
      const slots: TrackSlot[] = items.map((t) => {
        let pos = t.trackNo != null && t.trackNo > 0 && !used.has(t.trackNo) ? t.trackNo : 0;
        if (pos === 0) {
          while (used.has(nextFree)) nextFree++;
          pos = nextFree;
        }
        used.add(pos);
        const file = fileRecordFor(t);
        const parsed: ParsedName = {
          scheme: 'metadata',
          hasTrackNo: t.trackNo != null,
          ...(t.trackNo != null ? { trackNo: t.trackNo } : {}),
          ...(t.title ? { title: t.title } : {}),
        };
        return { file, parsed, discNo, position: pos, title: (t.title ?? '').trim() || file.name };
      });
      slots.sort((a, z) => a.position - z.position);
      discs.push({
        discNo,
        sourceDirs: [...new Set(slots.map((s) => s.file.dir))],
        tracks: slots,
        maxTrackNo: slots.reduce((m, s) => Math.max(m, s.position), 0),
      });
    }

    const totalTracks = b.tracks.length;
    const folderCount = b.folders.size;
    const confidence = totalTracks === 1 ? 0.4 : Math.min(0.75, 0.6 + Math.min(0.15, totalTracks * 0.01));
    const flags: CandidateFlag[] = folderCount > 1 ? ['multi-folder-merge'] : [];
    const evidence = [`Grouped by album tag “${b.album}”`, `Album-artist “${b.artist}”`];
    if (folderCount > 1) evidence.push(`Integrates ${totalTracks} tracks from ${folderCount} folders`);

    out.push({
      id: `meta:${n++}`,
      albumArtist: b.artist,
      albumTitle: b.album,
      ...(b.year != null ? { year: b.year } : {}),
      discs,
      totalTracks,
      completeness: 0,
      confidence,
      flags,
      evidence,
      schemes: ['metadata'],
      sizeBytes: b.tracks.reduce((s, x) => s + (x.t.sizeBytes ?? 0), 0),
    });
  }

  return out;
}
