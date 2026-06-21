/**
 * Ingest the REAL library into SQLite — the make-or-break stage.
 *
 * Pipeline (all READ-only on source media):
 *   1. scanLibraryCached(root)  -> tag-level Track[] (warm cache makes tag reads instant)
 *   2. reconstruct(tracks)      -> folder-based AlbumCandidate[] (album grouping)
 *   3. map each Track -> its owning AlbumCandidate via candidate membership (by file path)
 *   4. CANONICALIZE artists: resolve every album to ONE canonical artist that also matches the
 *      track-tag artists, so the artist->album->track hierarchy actually joins (see below)
 *   5. detect catch-all/compilation folders (low artist cohesion) -> Various Artists, no fake artist
 *   6. light title/artist cleanup (strip release-tag noise, prefer latest year in a range)
 *   7. compute overview stats (computeLibraryStats) + a tag-vs-folder grouping simulation
 *   8. populate SQLite (idempotent: clear + repopulate)
 *
 * ARTIST CANONICALIZATION — why this exists:
 *   The engine's reconstruct() derives an album-artist from the FOLDER name ("R.E.M"), while the
 *   track tags carry the real artist ("R.E.M."). A naive string-equal join then credits ZERO albums
 *   to the artist the user clicks. We fix this by, for each album, preferring the dominant TAG artist
 *   of its member tracks as the album's artistName, and by collapsing artist rows under a canonical
 *   key (trim, strip trailing punctuation, fold Various-Artists spellings). One row per real artist;
 *   albums and tracks join on the same name.
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

const FOLDER_ART = [
  'cover.jpg', 'folder.jpg', 'front.jpg', 'cover.jpeg', 'front.jpeg',
  'cover.png', 'folder.png', 'front.png', 'album.jpg', 'albumart.jpg',
  'Cover.jpg', 'Folder.jpg', 'Front.jpg', 'AlbumArt.jpg', 'thumb.jpg',
];
const LOSSLESS_EXT = new Set(['flac', 'alac', 'ape', 'wav', 'aiff', 'aif', 'wv', 'tta', 'tak']);

/** Cheap folder-art lookup (no tag parse): the first cover.jpg/folder.jpg sibling, if any. */
function folderCover(dir: string): string | undefined {
  for (const name of FOLDER_ART) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/* ----------------------------- artist canonicalization ----------------------------- */

const VARIOUS_ARTISTS = 'Various Artists';
const VA_RE = /^(?:va|v\.?a\.?|various(?:\s+artists?)?|varios|varios\s+artistas|ningún\s+artista|ningun\s+artista|verschiedene)$/i;

/**
 * Generic folder names that are NOT artists — they are catch-all/organisational folders. When an
 * album's only artist signal is a folder name on this list (because its tracks carry no artist tag),
 * we must NOT mint a junk artist row out of it. Kept deliberately tight so real artists never match.
 */
const GENERIC_FOLDER_ARTIST = new Set([
  'albums', 'album', 'albums flac', 'flac', 'music', 'musica', 'música', 'mp3', 'audio', 'audiobooks',
  'audiobook', 'playlist', 'playlists', 'car', 'car playlists', 'best', 'selection', 'selections',
  'compilations', 'compilation', 'misc', 'various', 'varios', 'singles', 'hits', 'ballad', 'ballads',
  'electronica', 'classicmania', 'reference recordings', 'different artists', 'new folder', 'unsorted',
  'downloads', 'temp', 'collection', 'collections', '01', '02', '03', 'cd', 'cd1', 'cd2', 'disc',
]);

/** True if the (folder-derived) artist name is a generic catch-all rather than a real artist. */
function isGenericFolderArtist(raw: string): boolean {
  const k = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  return GENERIC_FOLDER_ARTIST.has(k) || /^\d{1,3}$/.test(k);
}

/**
 * Canonical key for collapsing artist spellings into one identity:
 *  - trim + collapse internal whitespace
 *  - lowercase
 *  - fold all Various-Artists spellings to a single token
 *  - strip trailing punctuation ('R.E.M.' -> 'r.e.m' so it collapses with 'R.E.M')
 * Returns '' for empty/unknown (callers treat that as "no canonical artist").
 */
export function artistKey(raw: string | null | undefined): string {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (VA_RE.test(s)) return 'various artists';
  return s
    .toLowerCase()
    .replace(/[.\s,;:_'"`´·•]+$/g, '') // trailing punctuation/whitespace ('r.e.m.' -> 'r.e.m')
    .trim();
}

/** Is this a Various-Artists spelling? */
function isVA(raw: string | null | undefined): boolean {
  return artistKey(raw) === 'various artists';
}

/* ----------------------------- title / artist cleanup ------------------------------ */

/** Strip release-tag noise ([EAC FLAC], [Japan SHM-CD…], (FLAC), -CD-FLAC, scene tags, etc.). */
export function cleanTitle(raw: string): string {
  let t = raw;
  // bracketed/parenthetical scene & format tags
  t = t.replace(/[[(][^\])]*\b(eac|flac|wav|ape|mp3|cbr|vbr|320|256|192|16bit|24bit|24-?96|shm-?cd|hi-?res|lossless|web|cd-?rip|vinyl|remaster(?:ed)?|reissue|deluxe edition|bit|vtwin\w*|no\s*group)\b[^\])]*[\])]/gi, ' ');
  // trailing scene group / ripper credits after "by " or a double-dash
  t = t.replace(/\s+by\s+\w[\w.@-]*\s*$/i, ' ');
  t = t.replace(/--\s*\w+\s*$/i, ' ');
  // dangling format suffixes like " FLAC 16", " - CD - FLAC - 2007", " ( FLAC )"
  t = t.replace(/\s*[-(]?\s*\bflac\b\s*\d*\s*[)]?\s*$/i, ' ');
  // unbalanced trailing "(Virgin _VTDCDX570" style catalog dumps
  t = t.replace(/\s*[([][^)\]]*$/i, (m) => (/[)\]]/.test(m) ? m : ' '));
  t = t.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—._]+|[\s\-–—._]+$/g, '').trim();
  return t || raw.trim();
}

/**
 * Pick the most plausible year. The engine takes the FIRST 4-digit year it sees, which for a range
 * like "(1951-2001)" yields 1951 for a 2001 compilation. Prefer the LATEST year present in the source
 * folder name when a range/multiple years appear.
 */
export function bestYear(candidate: AlbumCandidate): number | undefined {
  const dir = candidate.discs[0]?.tracks[0]?.file.dir ?? '';
  const hay = `${candidate.albumTitle} ${dir}`;
  const years = [...hay.matchAll(/\b(19[0-9]{2}|20[0-9]{2})\b/g)].map((m) => Number(m[1]));
  if (years.length > 0) {
    const latest = Math.max(...years);
    // sanity: don't accept a future year
    const cap = new Date().getFullYear() + 1;
    const valid = years.filter((y) => y <= cap);
    return valid.length ? Math.max(...valid) : (latest <= cap ? latest : candidate.year);
  }
  return candidate.year;
}

/* --------------------------------- mapping types ----------------------------------- */

/** A reconstructed candidate plus resolved cover/source/canonical-artist for DB insertion. */
interface MappedAlbum {
  candidate: AlbumCandidate;
  coverPath: string | undefined;
  sourceDir: string;
  /** the canonical display artist this album belongs to (already VA-folded) */
  artistName: string;
  /** cleaned-up title + year */
  title: string;
  year: number | undefined;
  /** true if detected as a catch-all/compilation folder */
  isCompilation: boolean;
  extraFlags: string[];
}

/** Build path -> candidate id from reconstruct() membership. */
function indexCandidates(candidates: AlbumCandidate[]): Map<string, string> {
  const pathToAlbum = new Map<string, string>();
  for (const c of candidates) {
    for (const disc of c.discs) {
      for (const slot of disc.tracks) {
        pathToAlbum.set(slot.file.path, c.id);
      }
    }
  }
  return pathToAlbum;
}

/**
 * Resolve, for one album candidate, the canonical artist + whether it is a catch-all compilation.
 *
 *  - Gather the tag artists of the member tracks.
 *  - If the folder mixes many distinct artists (low cohesion) AND is sizable, it's a compilation:
 *    -> Various Artists, flagged, and we do NOT mint a fake artist named after the folder.
 *  - Otherwise pick the dominant tag artist (the spelling the user's tracks actually use) when it
 *    commands a majority; this is what makes 'R.E.M' (folder) collapse onto 'R.E.M.' (tags).
 *  - Fall back to the engine's candidate.albumArtist when tags are absent.
 */
function resolveAlbumArtist(
  c: AlbumCandidate,
  trackArtistByPath: Map<string, string | undefined>,
): { artistName: string; isCompilation: boolean } {
  const tagArtists: string[] = [];
  for (const disc of c.discs) {
    for (const slot of disc.tracks) {
      const a = trackArtistByPath.get(slot.file.path);
      if (a && a.trim()) tagArtists.push(a.trim());
    }
  }

  // distinct (by canonical key), with display-name + count
  const byKey = new Map<string, { display: string; count: number }>();
  for (const a of tagArtists) {
    const k = artistKey(a);
    if (!k) continue;
    const cur = byKey.get(k);
    if (cur) cur.count++;
    else byKey.set(k, { display: a, count: 1 });
  }
  const distinct = byKey.size;
  const total = tagArtists.length;

  // --- catch-all / compilation detection ---
  // A real single-artist album has 1 (or a couple, for feats) tag artists. A junk catch-all folder
  // ("Best", "Car", "Playlists") sweeps dozens-to-hundreds of unrelated artists into one folder.
  const distinctRatio = total > 0 ? distinct / total : 0;
  const cohesionCompilation = total >= 8 && distinct >= 5 && distinctRatio >= 0.4;
  const taggedVA = isVA(c.albumArtist);
  const folderVA = total === 0 && isVA(c.albumArtist);
  const isCompilation = cohesionCompilation || taggedVA || folderVA;

  if (isCompilation) return { artistName: VARIOUS_ARTISTS, isCompilation: true };

  // --- single-artist: prefer the dominant TAG artist (matches the user's track tags) ---
  if (byKey.size > 0) {
    let best: { display: string; count: number } | undefined;
    for (const v of byKey.values()) if (!best || v.count > best.count) best = v;
    if (best && best.count >= Math.ceil(total / 2)) {
      return { artistName: best.display, isCompilation: false };
    }
    // no clear majority but tags exist (e.g. a feat-heavy single-artist album): still prefer the
    // dominant tag spelling over the folder-derived name to keep the join intact.
    if (best) return { artistName: best.display, isCompilation: false };
  }

  // --- no usable tags: fall back to the engine's folder-derived artist ---
  const folderArtist = c.albumArtist.trim();
  if (!folderArtist || isGenericFolderArtist(folderArtist)) {
    // a generic catch-all folder ("Albums", "Playlists", "01", …) — don't mint a junk artist row.
    return { artistName: VARIOUS_ARTISTS, isCompilation: true };
  }
  return { artistName: folderArtist, isCompilation: false };
}

/**
 * Tag-vs-folder grouping simulation. The user explicitly wants this contrast shown:
 *  - folder grouping: how reconstruct() (folder cohesion) groups files; orphan TRACKS = tracks that
 *    land in a 1-track ('orphan') candidate.
 *  - tag grouping:    naive (albumArtist|album) tag key; orphan TRACKS = tracks with no usable album
 *                     tag PLUS tracks that fall in a singleton tag-group.
 * Both sides are counted in TRACKS so the headline delta is apples-to-apples.
 */
function groupingSimulation(tracks: Track[], candidates: AlbumCandidate[]) {
  // folder method (from the engine) — count orphan TRACKS, not orphan candidates
  const folderGroups = candidates.length;
  const orphanCandidates = candidates.filter((c) => c.flags.includes('orphan'));
  const folderOrphanTracks = orphanCandidates.reduce((n, c) => n + c.totalTracks, 0);

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
  // an "orphan" in the tag world = a track that can't be confidently placed in a multi-track album:
  // untagged tracks + each track sitting alone in a singleton tag-group (== singleton group count).
  const tagOrphanTracks = untagged + singletonTagGroups;

  return {
    folder: { groups: folderGroups, orphanCandidates: orphanCandidates.length, orphanTracks: folderOrphanTracks },
    tag: {
      groups: tagGroups,
      orphanTracks: tagOrphanTracks,
      untaggedTracks: untagged,
      singletonGroups: singletonTagGroups,
    },
    verdict:
      folderOrphanTracks <= tagOrphanTracks
        ? 'Folder reconstruction leaves fewer orphan tracks than naive tag grouping.'
        : 'Naive tag grouping leaves fewer orphan tracks than folder reconstruction.',
  };
}

function populate(db: DB, tracks: Track[], candidates: AlbumCandidate[], mapped: Map<string, MappedAlbum>): void {
  const pathToAlbum = indexCandidates(candidates);

  const insArtist = db.prepare('INSERT OR IGNORE INTO artists(name) VALUES(?)');
  const insAlbum = db.prepare(
    `INSERT INTO albums(id,artistName,title,year,coverPath,trackCount,lossless,flags,confidence,evidence,sourceDir,sizeBytes,discCount,completeness)
     VALUES(@id,@artistName,@title,@year,@coverPath,@trackCount,@lossless,@flags,@confidence,@evidence,@sourceDir,@sizeBytes,@discCount,@completeness)`,
  );
  const insTrack = db.prepare(
    `INSERT OR IGNORE INTO tracks(albumId,artistName,album,title,trackNo,discNo,durationMs,bitrateKbps,lossless,sizeBytes,path,genre,year)
     VALUES(@albumId,@artistName,@album,@title,@trackNo,@discNo,@durationMs,@bitrateKbps,@lossless,@sizeBytes,@path,@genre,@year)`,
  );

  // Canonical-key -> chosen display name. We register ONE artist row per canonical identity and map
  // every album/track onto that one display name so the hierarchy joins by exact string.
  const keyToDisplay = new Map<string, string>();
  /** Resolve the canonical display name for an artist spelling (registering it on first sight). */
  const canon = (raw: string | null | undefined): string | null => {
    const k = artistKey(raw);
    if (!k) return null;
    const existing = keyToDisplay.get(k);
    if (existing) return existing;
    const display = isVA(raw) ? VARIOUS_ARTISTS : (raw ?? '').replace(/\s+/g, ' ').trim();
    keyToDisplay.set(k, display);
    return display;
  };

  const tx = db.transaction(() => {
    // Pre-seed canonical display names from TAG artists first, so the user's own spelling wins as the
    // display name (e.g. 'R.E.M.' from tags beats 'R.E.M' from the folder).
    for (const t of tracks) {
      const tagArtist = t.albumArtist || t.artist;
      if (tagArtist) canon(tagArtist);
    }

    // albums + their (canonical) artists
    for (const c of candidates) {
      const m = mapped.get(c.id)!;
      const allLossless =
        c.totalTracks > 0 && c.discs.every((d) => d.tracks.every((s) => LOSSLESS_EXT.has(s.file.ext)));
      const artistName = canon(m.artistName) ?? m.artistName;
      insArtist.run(artistName);
      const flags = [...new Set([...c.flags, ...m.extraFlags])];
      insAlbum.run({
        id: c.id,
        artistName,
        title: m.title,
        year: m.year ?? null,
        coverPath: m.coverPath ?? null,
        trackCount: c.totalTracks,
        lossless: allLossless ? 1 : 0,
        flags: JSON.stringify(flags),
        confidence: c.confidence,
        evidence: JSON.stringify(c.evidence),
        sourceDir: m.sourceDir,
        sizeBytes: c.sizeBytes,
        discCount: c.discs.length,
        completeness: c.completeness,
      });
    }

    // tracks (linked to their album candidate by file path, artist canonicalized)
    for (const t of tracks) {
      const tagArtist = t.albumArtist || t.artist;
      const artistName = canon(tagArtist);
      if (artistName) insArtist.run(artistName);
      insTrack.run({
        albumId: pathToAlbum.get(t.path) ?? null,
        artistName: artistName ?? null,
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

    // roll up per-artist counts from the now-canonicalized tables. albumCount counts BOTH the albums
    // whose canonical artistName equals this artist AND any albums reachable through this artist's
    // tracks (defensive — keeps the count and the returned-albums list in agreement).
    db.exec(`
      UPDATE artists SET
        trackCount = (SELECT COUNT(*) FROM tracks t WHERE t.artistName = artists.name),
        albumCount = (
          SELECT COUNT(*) FROM albums a
          WHERE a.artistName = artists.name
             OR a.id IN (SELECT DISTINCT t2.albumId FROM tracks t2
                          WHERE t2.artistName = artists.name AND t2.albumId IS NOT NULL)
        );
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

export async function ingest(
  root: string,
  dbPath?: string,
  onProgress?: (done: number, total: number) => void,
): Promise<IngestResult> {
  console.log(`[ingest] scanning ${root} (tags via cache)…`);
  const t0 = Date.now();
  const scan = await scanLibraryCached(root, onProgress ? { onProgress } : {});
  console.log(
    `[ingest] scan done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${scan.tracks.length} tracks ` +
      `(cached ${scan.cached}, scanned ${scan.scanned}, removed ${scan.removed})`,
  );

  console.log('[ingest] reconstructing albums…');
  const report = reconstruct(scan.tracks);
  console.log(`[ingest] ${report.candidates.length} album candidates`);

  // a path -> tag-artist index so per-album artist resolution is O(tracks-in-album)
  const trackArtistByPath = new Map<string, string | undefined>();
  for (const t of scan.tracks) trackArtistByPath.set(t.path, t.albumArtist || t.artist);

  // resolve cover + source dir + canonical artist + cleaned title/year per candidate
  const mapped = new Map<string, MappedAlbum>();
  let compilations = 0;
  for (const c of report.candidates) {
    const firstFile = c.discs[0]?.tracks[0]?.file;
    const sourceDir = firstFile?.dir ?? '';
    const coverPath = sourceDir ? folderCover(sourceDir) : undefined;
    const { artistName, isCompilation } = resolveAlbumArtist(c, trackArtistByPath);
    if (isCompilation) compilations++;
    mapped.set(c.id, {
      candidate: c,
      coverPath,
      sourceDir,
      artistName,
      title: cleanTitle(c.albumTitle),
      year: bestYear(c),
      isCompilation,
      extraFlags: isCompilation ? ['possible-compilation'] : [],
    });
  }
  console.log(`[ingest] ${compilations} catch-all/compilation folders -> Various Artists`);

  const stats = computeLibraryStats(scan.tracks);
  const sim = groupingSimulation(scan.tracks, report.candidates);

  const db = openDb(dbPath);
  clearAll(db);
  populate(db, scan.tracks, report.candidates, mapped);

  // single source of truth for the artist headline: the canonicalized artists table
  const artistRows = (db.prepare('SELECT COUNT(*) c FROM artists').get() as { c: number }).c;

  // top artists from the CANONICALIZED table (not raw tags) so the Overview bar folds 'R.E.M'/'R.E.M.'
  // and the various 'Various'/'VA' spellings exactly like the Library list does.
  const topArtists = db
    .prepare('SELECT name, trackCount AS tracks FROM artists ORDER BY trackCount DESC, name LIMIT 8')
    .all() as Array<{ name: string; tracks: number }>;

  // overview meta
  setMeta(db, 'overview', {
    root,
    tracks: stats.tracks,
    albums: report.candidates.length,
    artists: artistRows, // <- matches /api/artists row count exactly
    genres: stats.genres,
    totalBytes: stats.totalBytes,
    totalHuman: humanBytes(stats.totalBytes),
    totalDurationMs: stats.totalDurationMs,
    losslessRatio: stats.losslessRatio,
    formats: stats.formats,
    topArtists,
    topGenres: stats.topGenres,
    topYears: stats.topYears,
    multiDisc: report.summary.multiDisc,
    needsReview: report.summary.needsReview,
    compilations,
    ingestedAt: new Date().toISOString(),
  });
  setMeta(db, 'grouping', sim);

  const counts = {
    tracks: (db.prepare('SELECT COUNT(*) c FROM tracks').get() as { c: number }).c,
    albums: (db.prepare('SELECT COUNT(*) c FROM albums').get() as { c: number }).c,
    artists: artistRows,
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
    .prepare('SELECT name, trackCount, albumCount FROM artists ORDER BY trackCount DESC, name LIMIT 10')
    .all() as Array<{ name: string; trackCount: number; albumCount: number }>;
  console.log('\nTop 10 artists by track count:');
  for (const a of topArtists)
    console.log(`  ${a.trackCount.toString().padStart(5)}t  ${a.albumCount.toString().padStart(3)}alb  ${a.name}`);

  const sampleAlbums = db
    .prepare(
      `SELECT title, artistName, year, trackCount, confidence
       FROM albums WHERE trackCount >= 5 ORDER BY trackCount DESC, title LIMIT 10`,
    )
    .all() as Array<{ title: string; artistName: string; year: number | null; trackCount: number; confidence: number }>;
  console.log('\n10 example reconstructed albums (real titles):');
  for (const a of sampleAlbums) {
    console.log(
      `  ${a.trackCount.toString().padStart(3)}t  ${a.artistName} — ${a.title}${a.year ? ` (${a.year})` : ''}  [conf ${a.confidence}]`,
    );
  }

  // R.E.M. join sanity check (the critical finding)
  const rem = db.prepare('SELECT name, trackCount, albumCount FROM artists WHERE name = ?').get('R.E.M.') as
    | { name: string; trackCount: number; albumCount: number }
    | undefined;
  console.log('\nJoin check — R.E.M.:', rem ?? '(no R.E.M. row!)');
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
