/**
 * Ingest the REAL library into SQLite — the make-or-break stage.
 *
 * Pipeline (all READ-only on source media):
 *   1. scanLibraryCached(root)  -> tag-level Track[] (warm cache makes tag reads instant)
 *   2. reconstruct(tracks)      -> folder-based AlbumCandidate[] (album grouping)
 *   3. map each Track -> its owning AlbumCandidate via candidate membership (by file path)
 *   4. compute overview stats (computeLibraryStats) + a tag-vs-folder grouping simulation
 *   5. populate SQLite (idempotent: clear + repopulate)
 *
 * Usage:  npx tsx src/server2/ingest.ts 'Y:\'   (or: npm run ingest -- 'Y:\')
 */
import {
  scanLibraryCached,
  reconstruct,
  computeLibraryStats,
  humanBytes,
  type Track,
  type AlbumCandidate,
} from '../engine/index.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, clearAll, setMeta, type DB } from './db.js';

const FOLDER_ART = ['cover.jpg', 'folder.jpg', 'front.jpg', 'cover.png', 'folder.png', 'album.jpg'];
const LOSSLESS_EXT = new Set(['flac', 'alac', 'ape', 'wav', 'aiff', 'aif', 'wv', 'tta', 'tak']);

/** Cheap folder-art lookup (no tag parse): the first cover.jpg/folder.jpg sibling, if any. */
function folderCover(dir: string): string | undefined {
  for (const name of FOLDER_ART) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** A reconstructed candidate plus its resolved cover + a flat track view for DB insertion. */
interface MappedAlbum {
  candidate: AlbumCandidate;
  coverPath: string | undefined;
  sourceDir: string;
}

/** Build path -> candidate id, and id -> candidate, from reconstruct() membership. */
function indexCandidates(candidates: AlbumCandidate[]): {
  pathToAlbum: Map<string, string>;
  byId: Map<string, AlbumCandidate>;
} {
  const pathToAlbum = new Map<string, string>();
  const byId = new Map<string, AlbumCandidate>();
  for (const c of candidates) {
    byId.set(c.id, c);
    for (const disc of c.discs) {
      for (const slot of disc.tracks) {
        pathToAlbum.set(slot.file.path, c.id);
      }
    }
  }
  return { pathToAlbum, byId };
}

/**
 * Tag-vs-folder grouping simulation. The user explicitly wants this contrast shown:
 *  - folder grouping: how reconstruct() (folder cohesion) groups files; orphans = 1-track candidates.
 *  - tag grouping:    naive (albumArtist|album) tag key; orphans = tracks with no usable album tag
 *                     PLUS singleton tag-groups.
 */
function groupingSimulation(tracks: Track[], candidates: AlbumCandidate[]) {
  // folder method (from the engine)
  const folderGroups = candidates.length;
  const folderOrphans = candidates.filter((c) => c.flags.includes('orphan')).length;

  // tag method
  const tagKeyCounts = new Map<string, number>();
  let untagged = 0;
  for (const t of tracks) {
    const artist = (t.albumArtist || t.artist || '').trim();
    const album = (t.album || '').trim();
    if (!album) {
      untagged++;
      continue;
    }
    const key = `${artist.toLowerCase()}|||${album.toLowerCase()}`;
    tagKeyCounts.set(key, (tagKeyCounts.get(key) ?? 0) + 1);
  }
  const tagGroups = tagKeyCounts.size;
  const singletonTagGroups = [...tagKeyCounts.values()].filter((n) => n === 1).length;
  // an "orphan" in the tag world = a track that can't be confidently placed in a multi-track album
  const tagOrphans = untagged + singletonTagGroups;

  return {
    folder: { groups: folderGroups, orphans: folderOrphans },
    tag: { groups: tagGroups, orphans: tagOrphans, untaggedTracks: untagged, singletonGroups: singletonTagGroups },
    verdict:
      folderOrphans <= tagOrphans
        ? 'Folder reconstruction leaves fewer orphans than naive tag grouping.'
        : 'Naive tag grouping leaves fewer orphans than folder reconstruction.',
  };
}

function populate(db: DB, tracks: Track[], candidates: AlbumCandidate[], mapped: Map<string, MappedAlbum>): void {
  const { pathToAlbum } = indexCandidates(candidates);

  const insArtist = db.prepare('INSERT OR IGNORE INTO artists(name) VALUES(?)');
  const insAlbum = db.prepare(
    `INSERT INTO albums(id,artistName,title,year,coverPath,trackCount,lossless,flags,confidence,evidence,sourceDir,sizeBytes,discCount,completeness)
     VALUES(@id,@artistName,@title,@year,@coverPath,@trackCount,@lossless,@flags,@confidence,@evidence,@sourceDir,@sizeBytes,@discCount,@completeness)`,
  );
  const insTrack = db.prepare(
    `INSERT OR IGNORE INTO tracks(albumId,artistName,album,title,trackNo,discNo,durationMs,bitrateKbps,lossless,sizeBytes,path,genre,year)
     VALUES(@albumId,@artistName,@album,@title,@trackNo,@discNo,@durationMs,@bitrateKbps,@lossless,@sizeBytes,@path,@genre,@year)`,
  );

  const tx = db.transaction(() => {
    // albums + the artists they reference
    for (const c of candidates) {
      const m = mapped.get(c.id)!;
      const allLossless = c.totalTracks > 0 && c.discs.every((d) => d.tracks.every((s) => LOSSLESS_EXT.has(s.file.ext)));
      insArtist.run(c.albumArtist);
      insAlbum.run({
        id: c.id,
        artistName: c.albumArtist,
        title: c.albumTitle,
        year: c.year ?? null,
        coverPath: m.coverPath ?? null,
        trackCount: c.totalTracks,
        lossless: allLossless ? 1 : 0,
        flags: JSON.stringify(c.flags),
        confidence: c.confidence,
        evidence: JSON.stringify(c.evidence),
        sourceDir: m.sourceDir,
        sizeBytes: c.sizeBytes,
        discCount: c.discs.length,
        completeness: c.completeness,
      });
    }

    // tracks (linked to their album candidate by file path)
    for (const t of tracks) {
      const tagArtist = t.albumArtist || t.artist;
      if (tagArtist) insArtist.run(tagArtist);
      insTrack.run({
        albumId: pathToAlbum.get(t.path) ?? null,
        artistName: tagArtist ?? null,
        album: t.album ?? null,
        title: t.title,
        trackNo: t.trackNo ?? null,
        discNo: t.discNo ?? null,
        durationMs: t.durationMs ?? null,
        bitrateKbps: t.bitrateKbps ?? null,
        lossless: t.lossless ? 1 : 0,
        sizeBytes: t.sizeBytes,
        path: t.path,
        genre: t.genre ?? null,
        year: t.year ?? null,
      });
    }

    // roll up per-artist counts from the now-populated tables
    db.exec(`
      UPDATE artists SET
        trackCount = (SELECT COUNT(*) FROM tracks t WHERE t.artistName = artists.name),
        albumCount = (SELECT COUNT(*) FROM albums a WHERE a.artistName = artists.name);
    `);
  });
  tx();
}

export interface IngestResult {
  tracks: number;
  albums: number;
  artists: number;
  cached: number;
  scanned: number;
}

export async function ingest(root: string, dbPath?: string): Promise<IngestResult> {
  console.log(`[ingest] scanning ${root} (tags via cache)…`);
  const t0 = Date.now();
  const scan = await scanLibraryCached(root);
  console.log(
    `[ingest] scan done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${scan.tracks.length} tracks ` +
      `(cached ${scan.cached}, scanned ${scan.scanned}, removed ${scan.removed})`,
  );

  console.log('[ingest] reconstructing albums…');
  const report = reconstruct(scan.tracks);
  console.log(`[ingest] ${report.candidates.length} album candidates`);

  // resolve a cover + source dir per candidate (best-effort; reads embedded/folder art only)
  const mapped = new Map<string, MappedAlbum>();
  for (const c of report.candidates) {
    const firstFile = c.discs[0]?.tracks[0]?.file;
    const sourceDir = firstFile?.dir ?? '';
    const coverPath = sourceDir ? folderCover(sourceDir) : undefined;
    mapped.set(c.id, { candidate: c, coverPath, sourceDir });
  }

  const stats = computeLibraryStats(scan.tracks);
  const sim = groupingSimulation(scan.tracks, report.candidates);

  const db = openDb(dbPath);
  clearAll(db);
  populate(db, scan.tracks, report.candidates, mapped);

  // overview meta
  setMeta(db, 'overview', {
    root,
    tracks: stats.tracks,
    albums: report.candidates.length,
    artists: stats.artists,
    genres: stats.genres,
    totalBytes: stats.totalBytes,
    totalHuman: humanBytes(stats.totalBytes),
    totalDurationMs: stats.totalDurationMs,
    losslessRatio: stats.losslessRatio,
    formats: stats.formats,
    topArtists: stats.topArtists,
    topGenres: stats.topGenres,
    topYears: stats.topYears,
    multiDisc: report.summary.multiDisc,
    needsReview: report.summary.needsReview,
    ingestedAt: new Date().toISOString(),
  });
  setMeta(db, 'grouping', sim);

  const counts = {
    tracks: (db.prepare('SELECT COUNT(*) c FROM tracks').get() as { c: number }).c,
    albums: (db.prepare('SELECT COUNT(*) c FROM albums').get() as { c: number }).c,
    artists: (db.prepare('SELECT COUNT(*) c FROM artists').get() as { c: number }).c,
    cached: scan.cached,
    scanned: scan.scanned,
  };
  db.close();
  return counts;
}

/** CLI entry: print real verification numbers + sample names from the user's collection. */
async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: tsx src/server2/ingest.ts '<root>'   e.g.  'Y:\\\\'");
    process.exit(1);
  }
  const res = await ingest(root);

  const db = openDb();
  console.log('\n=== INGEST VERIFICATION (real data) ===');
  console.log(`total tracks : ${res.tracks}`);
  console.log(`total albums : ${res.albums}`);
  console.log(`total artists: ${res.artists}`);

  const topArtists = db
    .prepare('SELECT name, trackCount FROM artists ORDER BY trackCount DESC, name LIMIT 10')
    .all() as Array<{ name: string; trackCount: number }>;
  console.log('\nTop 10 artists by track count:');
  for (const a of topArtists) console.log(`  ${a.trackCount.toString().padStart(5)}  ${a.name}`);

  const sampleAlbums = db
    .prepare(
      `SELECT title, artistName, year, trackCount, confidence
       FROM albums WHERE trackCount >= 5 ORDER BY trackCount DESC, title LIMIT 10`,
    )
    .all() as Array<{ title: string; artistName: string; year: number | null; trackCount: number; confidence: number }>;
  console.log('\n10 example reconstructed albums (real titles):');
  for (const a of sampleAlbums) {
    console.log(`  ${a.trackCount.toString().padStart(3)}t  ${a.artistName} — ${a.title}${a.year ? ` (${a.year})` : ''}  [conf ${a.confidence}]`);
  }
  db.close();
}

// run when invoked directly (tsx)
const invoked = process.argv[1]?.replace(/\\/g, '/').endsWith('server2/ingest.ts');
if (invoked) {
  main().catch((e) => {
    console.error('[ingest] FAILED:', e);
    process.exit(1);
  });
}
