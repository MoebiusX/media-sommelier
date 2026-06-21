/**
 * Media Sommelier API server (server2) — the new app's backend.
 *
 * Zero-framework Node http server on port 4178. Opens the SQLite database at
 * data/sommelier.db (created if missing) via better-sqlite3, exposes /api/health,
 * and provides a json() response helper. Data stages (ingest, query endpoints)
 * build on top of this. SOURCE MEDIA IS NEVER MUTATED — only data/ is written.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { readCover } from '../engine/index.js';

const PORT = Number(process.env.PORT ?? 4178);
// SECURITY: bind localhost-only by default — the API returns absolute source paths and must not be
// reachable beyond this machine. Override HOST only for an explicitly-trusted deployment.
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = resolve(process.env.SOMMELIER_DB ?? 'data/sommelier.db');

/** Open (or create) the SQLite database, ensuring its parent directory exists. */
export function openDb(dbPath: string = DB_PATH): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Minimal bootstrap table so a fresh DB is queryable; real schema lands in the ingest stage.
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0')`).run();
  return db;
}

/** Write a JSON response with the given status code. */
export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Read a JSON meta blob, returning undefined if missing. */
function meta<T>(db: Database.Database, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

interface OverviewMeta {
  tracks: number;
  albums: number;
  artists: number;
  totalBytes: number;
  totalHuman: string;
  totalDurationMs: number;
  losslessRatio: number;
  formats: Record<string, number>;
  topArtists: Array<{ name: string; tracks: number }>;
  topGenres: Array<{ name: string; tracks: number }>;
  topYears: Array<{ year: number; tracks: number }>;
}

interface GroupingMeta {
  folder: { groups: number; orphanCandidates: number; orphanTracks: number };
  tag: { groups: number; orphanTracks: number; untaggedTracks: number; singletonGroups: number };
  verdict: string;
}

/** GET /api/overview — library-wide stats + the tag-vs-folder grouping simulation. */
function overview(db: Database.Database, res: ServerResponse): void {
  const ov = meta<OverviewMeta>(db, 'overview');
  const g = meta<GroupingMeta>(db, 'grouping');
  if (!ov) {
    json(res, 503, { ok: false, error: 'not_ingested', message: 'Run the ingest stage first.' });
    return;
  }
  json(res, 200, {
    tracks: ov.tracks,
    albums: ov.albums,
    artists: ov.artists,
    totalBytes: ov.totalBytes,
    totalHuman: ov.totalHuman,
    totalDurationMs: ov.totalDurationMs,
    losslessRatio: ov.losslessRatio,
    formats: ov.formats,
    topArtists: ov.topArtists,
    topGenres: ov.topGenres,
    topYears: ov.topYears,
    simulation: g
      ? {
          // both sides reported in TRACKS so the headline delta is apples-to-apples
          tag: {
            groups: g.tag.groups,
            orphanTracks: g.tag.orphanTracks,
          },
          folder: {
            // albums reconstructed (whole groups), and how many TRACKS still fall out as orphans
            groups: g.folder.groups,
            orphanTracks: g.folder.orphanTracks,
          },
          verdict: g.verdict,
        }
      : null,
  });
}

/** GET /api/artists — every artist with track & album counts, busiest first. */
function artists(db: Database.Database, res: ServerResponse): void {
  const rows = db
    .prepare(
      `SELECT name, trackCount, albumCount FROM artists
       ORDER BY trackCount DESC, albumCount DESC, name ASC`,
    )
    .all();
  json(res, 200, rows);
}

/** GET /api/artist/:name — one artist with their reconstructed albums. */
function artist(db: Database.Database, res: ServerResponse, name: string): void {
  const a = db.prepare('SELECT name, trackCount, albumCount FROM artists WHERE name = ?').get(name) as
    | { name: string; trackCount: number; albumCount: number }
    | undefined;
  if (!a) {
    json(res, 404, { ok: false, error: 'artist_not_found', name });
    return;
  }
  // Return albums both whose canonical artistName IS this artist AND any album reachable through this
  // artist's tracks (covers compilations the artist appears on). This matches how albumCount is rolled
  // up in ingest, so the count and the list always agree.
  const albums = db
    .prepare(
      `SELECT id, title, year, coverPath, trackCount, flags, confidence, lossless, discCount
       FROM albums
       WHERE artistName = @name
          OR id IN (
            SELECT DISTINCT t.albumId FROM tracks t
            WHERE t.artistName = @name AND t.albumId IS NOT NULL
          )
       ORDER BY year ASC, title ASC`,
    )
    .all({ name }) as Array<{ flags: string; lossless: number; [k: string]: unknown }>;
  json(res, 200, {
    name: a.name,
    trackCount: a.trackCount,
    albumCount: a.albumCount,
    albums: albums.map((al) => ({
      ...al,
      flags: JSON.parse(al.flags),
      lossless: al.lossless === 1,
    })),
  });
}

/** GET /api/album/:id — one album with its tracks ordered by disc/track. */
function album(db: Database.Database, res: ServerResponse, id: string): void {
  const al = db.prepare('SELECT * FROM albums WHERE id = ?').get(id) as
    | { flags: string; evidence: string; lossless: number; [k: string]: unknown }
    | undefined;
  if (!al) {
    json(res, 404, { ok: false, error: 'album_not_found', id });
    return;
  }
  const tracks = db
    .prepare(
      `SELECT id, title, artistName, trackNo, discNo, durationMs, bitrateKbps, lossless, sizeBytes, genre, year, path
       FROM tracks WHERE albumId = ?
       ORDER BY COALESCE(discNo, 1) ASC, COALESCE(trackNo, 9999) ASC, title ASC`,
    )
    .all(id) as Array<{ lossless: number; [k: string]: unknown }>;
  json(res, 200, {
    ...al,
    flags: JSON.parse(al.flags),
    evidence: JSON.parse(al.evidence),
    lossless: al.lossless === 1,
    tracks: tracks.map((t) => ({ ...t, lossless: t.lossless === 1 })),
  });
}

/**
 * GET /api/cover?albumId= | ?path= — serve a cover image, READ-ONLY and confined to the
 * indexed source. A raw ?path= must exactly match an indexed track or album path/source, so
 * arbitrary filesystem reads are impossible.
 */
async function cover(
  db: Database.Database,
  res: ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  const albumId = params.get('albumId');
  const rawPath = params.get('path');

  // Build an ordered list of candidate paths to try (folder cover first, then several tracks for
  // embedded art). A single FLAC can fail to yield a picture even though a sibling track has one, so
  // we don't give up after the first miss.
  const lookupPaths: string[] = [];
  if (albumId) {
    const row = db.prepare('SELECT coverPath FROM albums WHERE id = ?').get(albumId) as
      | { coverPath: string | null }
      | undefined;
    if (row?.coverPath) lookupPaths.push(row.coverPath);
    // fall back to embedded art from up to 5 of the album's tracks
    const ts = db
      .prepare(
        `SELECT path FROM tracks WHERE albumId = ?
         ORDER BY COALESCE(discNo, 1), COALESCE(trackNo, 9999) LIMIT 5`,
      )
      .all(albumId) as Array<{ path: string }>;
    for (const t of ts) lookupPaths.push(t.path);
  } else if (rawPath) {
    // SECURITY (belt and suspenders): the path must (a) resolve under the indexed library root AND
    // (b) exactly match an indexed track/cover/source path. Either alone is sufficient today; both
    // together make the read-only invariant explicit rather than implied by the DB's contents.
    const root = meta<{ root?: string }>(db, 'overview')?.root;
    const resolved = resolve(rawPath);
    const underRoot =
      root != null && (resolved === resolve(root) || resolved.startsWith(resolve(root) + sep));
    const known =
      (db.prepare('SELECT 1 FROM tracks WHERE path = ?').get(rawPath) as unknown) ??
      (db.prepare('SELECT 1 FROM albums WHERE coverPath = ?').get(rawPath) as unknown) ??
      (db.prepare('SELECT 1 FROM albums WHERE sourceDir = ?').get(rawPath) as unknown);
    if (underRoot && known) lookupPaths.push(rawPath);
  }

  if (lookupPaths.length === 0) {
    json(res, 404, { ok: false, error: 'cover_not_found' });
    return;
  }

  for (const p of lookupPaths) {
    const c = await readCover(p);
    if (c) {
      res.writeHead(200, {
        'Content-Type': c.mime,
        'Content-Length': c.data.length,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(c.data);
      return;
    }
  }
  json(res, 404, { ok: false, error: 'no_cover_art' });
}

function handle(db: Database.Database, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === '/api/health') {
    const version = (db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined)?.value;
    json(res, 200, {
      ok: true,
      service: 'media-sommelier-api',
      db: DB_PATH,
      schemaVersion: version ?? null,
      uptimeSec: Math.round(process.uptime()),
    });
    return;
  }

  if (path === '/api/overview') return overview(db, res);
  if (path === '/api/artists') return artists(db, res);
  if (path === '/api/cover') {
    void cover(db, res, url.searchParams).catch((err) =>
      json(res, 500, { ok: false, error: 'cover_failed', message: (err as Error).message }),
    );
    return;
  }

  const artistMatch = /^\/api\/artist\/(.+)$/.exec(path);
  if (artistMatch) return artist(db, res, decodeURIComponent(artistMatch[1]!));

  const albumMatch = /^\/api\/album\/(.+)$/.exec(path);
  if (albumMatch) return album(db, res, decodeURIComponent(albumMatch[1]!));

  json(res, 404, { ok: false, error: 'not_found', path });
}

export function start(): void {
  const db = openDb();
  const server = createServer((req, res) => {
    try {
      handle(db, req, res);
    } catch (err) {
      json(res, 500, { ok: false, error: 'internal', message: (err as Error).message });
    }
  });
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`[server2] listening on http://${HOST}:${PORT}  db=${DB_PATH}`);
  });
}

// Start when run directly (tsx src/server2/index.ts), but stay importable for tests.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server2/index.ts') === true ||
  process.argv[1]?.endsWith('server2\\index.ts') === true;
if (isMain) start();
