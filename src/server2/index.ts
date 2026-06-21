/**
 * Media Sommelier API server (server2) — the new app's backend.
 *
 * Zero-framework Node http server on port 4178. Opens the SQLite database at
 * data/sommelier.db (created if missing) via better-sqlite3 and exposes:
 *   - read endpoints: /api/overview, /api/artists, /api/artist/:name, /api/album/:id, /api/cover
 *   - CONTROLS:        /api/pick-folder, POST /api/scan + /api/scan/status (index any folder),
 *                      /api/presets, POST /api/organize/plan, POST /api/organize/run + /api/organize/status
 *
 * SOURCE MEDIA IS NEVER MUTATED — scanning only READS; organize only COPIES to a new tree (the engine
 * enforces dest-outside-source + collision-fail). Only data/ and the chosen destination are written.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import {
  readCover,
  walkToArray,
  reconstruct,
  planOrganize,
  executePlan,
  ORGANIZE_PRESETS,
  type OrganizePlan,
} from '../engine/index.js';
import { ingest } from './ingest.js';

const PORT = Number(process.env.PORT ?? 4178);
// SECURITY: bind localhost-only by default — the API returns absolute source paths and triggers file
// copies, so it must not be reachable beyond this machine. Override HOST only for a trusted deployment.
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = resolve(process.env.SOMMELIER_DB ?? 'data/sommelier.db');
const execFileAsync = promisify(execFile);

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

/** Read and JSON-parse a request body (tolerant: returns {} on empty/invalid). */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => {
      try {
        resolve(s ? (JSON.parse(s) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** Native Windows folder picker so "point at a folder" is one click. Empty string if cancelled. */
async function pickFolder(): Promise<string> {
  if (process.platform !== 'win32') return '';
  const ps =
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null; ' +
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
    "$d.Description = 'Choose a media folder'; " +
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }';
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-STA', '-Command', ps], {
      timeout: 120_000,
    });
    return stdout.trim();
  } catch {
    return '';
  }
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

/* ============================ background jobs (controls) ============================ */
// The scan + organize controls do real, slow work (filesystem walks, tag reads, file copies). We run
// them as a single in-flight job each, started by a POST and polled by the UI via GET /status.

interface Job {
  state: 'idle' | 'running' | 'done' | 'error';
  source?: string;
  dest?: string;
  phase: string;
  done: number;
  total: number;
  result?: unknown;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

let scanJob: Job = { state: 'idle', phase: '', done: 0, total: 0 };
let organizeJob: Job = { state: 'idle', phase: '', done: 0, total: 0 };

/** Start indexing a folder into SQLite (point-at-a-folder control). No-op if one is already running. */
function startScan(source: string): void {
  if (scanJob.state === 'running') return;
  scanJob = { state: 'running', source, phase: 'walking folder + reading tags', done: 0, total: 0, startedAt: Date.now() };
  void (async () => {
    try {
      const res = await ingest(source, undefined, (done, total) => {
        scanJob.done = done;
        scanJob.total = total;
        scanJob.phase = 'reading tags';
      });
      scanJob = { ...scanJob, state: 'done', phase: 'done', result: res, finishedAt: Date.now() };
    } catch (e) {
      scanJob = { ...scanJob, state: 'error', error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() };
    }
  })();
}

/** Build an organize plan from a source folder (walk → reconstruct → planOrganize). READ-only. */
async function planFor(source: string, dest: string, presetKey: string): Promise<OrganizePlan> {
  const records = await walkToArray(source, { include: ['music'] });
  const report = reconstruct(records);
  const preset = ORGANIZE_PRESETS[presetKey];
  return planOrganize(report.candidates, {
    destRoot: dest,
    ...(preset ? { template: preset.template } : {}),
  });
}

/** Start the organize copy (the payoff control). Plans, then copies to a NEW tree; originals untouched. */
function startOrganize(source: string, dest: string, presetKey: string, writeTags: boolean): void {
  if (organizeJob.state === 'running') return;
  organizeJob = { state: 'running', source, dest, phase: 'planning', done: 0, total: 0, startedAt: Date.now() };
  void (async () => {
    try {
      const plan = await planFor(source, dest, presetKey);
      organizeJob.total = plan.actions.length;
      organizeJob.phase = 'copying';
      const rep = await executePlan(plan, {
        sourceRoot: source, // enforces dest-outside-source + lets the engine skip already-organized files
        writeTags,
        onProgress: (done, total) => {
          organizeJob.done = done;
          organizeJob.total = total;
        },
      });
      organizeJob = {
        ...organizeJob,
        state: 'done',
        phase: 'done',
        result: {
          copied: rep.copied,
          skipped: rep.skipped,
          failed: rep.failed,
          tagged: rep.tagged,
          bytes: rep.bytesCopied,
          dest,
        },
        finishedAt: Date.now(),
      };
    } catch (e) {
      organizeJob = { ...organizeJob, state: 'error', error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() };
    }
  })();
}

/* =================================== read endpoints =================================== */

/** GET /api/overview — library-wide stats + the tag-vs-folder grouping simulation. */
function overview(db: Database.Database, res: ServerResponse): void {
  const ov = meta<OverviewMeta>(db, 'overview');
  const g = meta<GroupingMeta>(db, 'grouping');
  if (!ov) {
    json(res, 503, { ok: false, error: 'not_ingested', message: 'Scan a folder first.' });
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
          tag: { groups: g.tag.groups, orphanTracks: g.tag.orphanTracks },
          folder: { groups: g.folder.groups, orphanTracks: g.folder.orphanTracks },
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
    albums: albums.map((al) => ({ ...al, flags: JSON.parse(al.flags), lossless: al.lossless === 1 })),
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
 * GET /api/cover?albumId= | ?path= — serve a cover image, READ-ONLY and confined to the indexed source.
 * A raw ?path= must resolve under the indexed root AND exactly match an indexed track/album path.
 */
async function cover(db: Database.Database, res: ServerResponse, params: URLSearchParams): Promise<void> {
  const albumId = params.get('albumId');
  const rawPath = params.get('path');
  const lookupPaths: string[] = [];
  if (albumId) {
    const row = db.prepare('SELECT coverPath FROM albums WHERE id = ?').get(albumId) as
      | { coverPath: string | null }
      | undefined;
    if (row?.coverPath) lookupPaths.push(row.coverPath);
    const ts = db
      .prepare(
        `SELECT path FROM tracks WHERE albumId = ?
         ORDER BY COALESCE(discNo, 1), COALESCE(trackNo, 9999) LIMIT 5`,
      )
      .all(albumId) as Array<{ path: string }>;
    for (const t of ts) lookupPaths.push(t.path);
  } else if (rawPath) {
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

/* ====================================== router ====================================== */

async function handle(db: Database.Database, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/api/health') {
    const version = (db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined)?.value;
    return json(res, 200, {
      ok: true,
      service: 'media-sommelier-api',
      db: DB_PATH,
      schemaVersion: version ?? null,
      uptimeSec: Math.round(process.uptime()),
    });
  }

  // ---- controls ----
  if (path === '/api/presets') return json(res, 200, ORGANIZE_PRESETS);
  if (path === '/api/pick-folder') return json(res, 200, { path: await pickFolder() });

  if (path === '/api/scan' && method === 'POST') {
    const b = await readBody(req);
    const source = String(b.source ?? '').trim();
    if (!source) return json(res, 400, { ok: false, error: 'no_source' });
    if (scanJob.state === 'running') return json(res, 409, { ok: false, error: 'scan_in_progress', job: scanJob });
    startScan(source);
    return json(res, 202, { ok: true, job: scanJob });
  }
  if (path === '/api/scan/status') return json(res, 200, scanJob);

  if (path === '/api/organize/plan' && method === 'POST') {
    const b = await readBody(req);
    const source = String(b.source ?? '').trim();
    const dest = String(b.dest ?? '').trim();
    const preset = String(b.preset ?? 'artist-year-album');
    if (!source || !dest) return json(res, 400, { ok: false, error: 'need_source_and_dest' });
    const plan = await planFor(source, dest, preset);
    return json(res, 200, {
      actions: plan.actions.length,
      collisions: plan.collisions.length,
      skipped: plan.skipped.length,
      sample: plan.actions.slice(0, 60).map((a) => a.destRelPath),
    });
  }
  if (path === '/api/organize/run' && method === 'POST') {
    const b = await readBody(req);
    const source = String(b.source ?? '').trim();
    const dest = String(b.dest ?? '').trim();
    const preset = String(b.preset ?? 'artist-year-album');
    const writeTags = !!b.writeTags;
    if (!source || !dest) return json(res, 400, { ok: false, error: 'need_source_and_dest' });
    if (organizeJob.state === 'running')
      return json(res, 409, { ok: false, error: 'organize_in_progress', job: organizeJob });
    startOrganize(source, dest, preset, writeTags);
    return json(res, 202, { ok: true, job: organizeJob });
  }
  if (path === '/api/organize/status') return json(res, 200, organizeJob);

  // ---- read endpoints ----
  if (path === '/api/overview') return overview(db, res);
  if (path === '/api/artists') return artists(db, res);
  if (path === '/api/cover') return cover(db, res, url.searchParams);

  const artistMatch = /^\/api\/artist\/(.+)$/.exec(path);
  if (artistMatch) return artist(db, res, decodeURIComponent(artistMatch[1]!));

  const albumMatch = /^\/api\/album\/(.+)$/.exec(path);
  if (albumMatch) return album(db, res, decodeURIComponent(albumMatch[1]!));

  json(res, 404, { ok: false, error: 'not_found', path });
}

export function start(): void {
  const db = openDb();
  const server = createServer((req, res) => {
    handle(db, req, res).catch((err) =>
      json(res, 500, { ok: false, error: 'internal', message: (err as Error).message }),
    );
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
