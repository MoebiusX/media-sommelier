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
import { mkdirSync, createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import {
  readCover,
  walkToArray,
  reconstruct,
  planOrganize,
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

/**
 * True if `target` resolves to `root` or sits inside it. Handles the drive-root case correctly:
 * resolve('Y:\\') already ends in a separator, so naively appending one yields 'Y:\\\\' and every
 * real path fails to match — hence the endsWith(sep) guard.
 */
function isUnderRoot(root: string | undefined, target: string): boolean {
  if (root == null) return false;
  const r = resolve(root);
  const t = resolve(target);
  if (t === r) return true;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
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
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  source?: string;
  dest?: string;
  phase: string;
  done: number;
  total: number;
  pid?: number;
  result?: unknown;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

let scanJob: Job = { state: 'idle', phase: '', done: 0, total: 0 };
let organizeJob: Job = { state: 'idle', phase: '', done: 0, total: 0 };
let organizeChild: ChildProcess | null = null;
const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'organize-worker.ts');

/** Start indexing a folder into SQLite (point-at-a-folder control). No-op if one is already running. */
function startScan(source: string): void {
  if (scanJob.state === 'running') return;
  reportCache.delete(source); // re-indexing implies the folder may have changed — drop the cached walk
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

/**
 * Walk + reconstruct is the slow step (a network-drive walk over 10K+ files takes ~minutes); the
 * naming scheme never affects it. Cache the reconstructed report per source so Simulate, Preview, and
 * repeat runs share ONE walk. Invalidated when that source is re-scanned (it may have changed on disk).
 */
const reportCache = new Map<string, ReturnType<typeof reconstruct>>();

async function reportFor(source: string): Promise<ReturnType<typeof reconstruct>> {
  const hit = reportCache.get(source);
  if (hit) return hit;
  const records = await walkToArray(source, { include: ['music'] });
  const report = reconstruct(records);
  reportCache.set(source, report);
  return report;
}

/** Build an organize plan from a source folder (walk → reconstruct → planOrganize). READ-only. */
async function planFor(source: string, dest: string, presetKey: string): Promise<OrganizePlan> {
  const report = await reportFor(source);
  const preset = ORGANIZE_PRESETS[presetKey];
  return planOrganize(report.candidates, {
    destRoot: dest,
    ...(preset ? { template: preset.template } : {}),
  });
}

/* ---- scheme simulation: score every naming preset by resulting folder sparsity ----
 * The whole point: pick a scheme WITHOUT trial-and-error organize runs. We walk + reconstruct ONCE
 * (cheap — the walk reads only directory entries, not tags) then apply every template in memory. A
 * "sparse" folder (1–2 tracks) means an album got fragmented; fewer is better. */

interface SchemeStat {
  key: string;
  label: string;
  template: string;
  folders: number;
  tracks: number;
  singletonFolders: number;
  sparseFolders: number;
  sparseTracks: number;
  medianPerFolder: number;
  largestFolder: number;
  collisions: number;
  skipped: number;
  hist: Array<{ label: string; folders: number }>;
}

/** Directory portion of a '/'-joined relative path ('' for a file with no folder, i.e. the flat scheme). */
const folderOf = (rel: string): string => {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

function statForScheme(
  key: string,
  label: string,
  template: string,
  candidates: Parameters<typeof planOrganize>[0],
): SchemeStat {
  const plan = planOrganize(candidates, { destRoot: 'SIM', template });
  const byFolder = new Map<string, number>();
  for (const a of plan.actions) {
    const f = folderOf(a.destRelPath);
    byFolder.set(f, (byFolder.get(f) ?? 0) + 1);
  }
  const counts = [...byFolder.values()];
  let one = 0;
  let two = 0;
  let threeToFive = 0;
  let sixToTen = 0;
  let elevenPlus = 0;
  let singleton = 0;
  let sparse = 0;
  let sparseTracks = 0;
  for (const c of counts) {
    if (c === 1) {
      one++;
      singleton++;
    } else if (c === 2) two++;
    else if (c <= 5) threeToFive++;
    else if (c <= 10) sixToTen++;
    else elevenPlus++;
    if (c <= 2) {
      sparse++;
      sparseTracks += c;
    }
  }
  return {
    key,
    label,
    template,
    folders: counts.length,
    tracks: plan.actions.length,
    singletonFolders: singleton,
    sparseFolders: sparse,
    sparseTracks,
    medianPerFolder: median(counts),
    largestFolder: counts.length ? Math.max(...counts) : 0,
    collisions: plan.collisions.length,
    skipped: plan.skipped.length,
    hist: [
      { label: '1', folders: one },
      { label: '2', folders: two },
      { label: '3–5', folders: threeToFive },
      { label: '6–10', folders: sixToTen },
      { label: '11+', folders: elevenPlus },
    ],
  };
}

/** Walk+reconstruct once (cached), then rank every naming preset by sparse-folder count. READ-only. */
async function simulateSchemes(
  source: string,
): Promise<{ source: string; schemes: SchemeStat[]; recommended: string | null }> {
  const report = await reportFor(source);
  const schemes = Object.entries(ORGANIZE_PRESETS).map(([k, p]) =>
    statForScheme(k, p.label, p.template, report.candidates),
  );
  // Recommend the best *foldered* scheme; 'flat' has one folder by design, so it's never the answer here.
  const ranked = schemes
    .filter((s) => s.key !== 'flat')
    .sort((a, b) => a.sparseFolders - b.sparseFolders || a.folders - b.folders);
  return { source, schemes, recommended: ranked[0]?.key ?? null };
}

/**
 * Start the organize copy (the payoff). Spawns the reorg as a CHILD PROCESS of this server so the long
 * file copy runs isolated (killable, non-blocking) and streams progress back over stdout. Originals are
 * never touched — the worker uses executePlan with the dest-outside-source guard.
 */
function startOrganize(source: string, dest: string, presetKey: string, writeTags: boolean): void {
  if (organizeJob.state === 'running') return;
  organizeJob = { state: 'running', source, dest, phase: 'starting worker', done: 0, total: 0, startedAt: Date.now() };

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', WORKER, source, dest, presetKey, String(writeTags)],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  organizeChild = child;
  organizeJob.pid = child.pid;

  let buf = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // ignore any non-JSON noise from libraries
      }
      if (msg.type === 'plan') {
        organizeJob.total = Number(msg.actions ?? organizeJob.total);
        organizeJob.phase = 'copying';
      } else if (msg.type === 'progress') {
        organizeJob.done = Number(msg.done ?? organizeJob.done);
        organizeJob.total = Number(msg.total ?? organizeJob.total);
        if (typeof msg.phase === 'string') organizeJob.phase = msg.phase;
        else organizeJob.phase = 'copying';
      } else if (msg.type === 'done') {
        organizeJob = {
          ...organizeJob,
          state: 'done',
          phase: 'done',
          result: { copied: msg.copied, skipped: msg.skipped, failed: msg.failed, tagged: msg.tagged, bytes: msg.bytes, dest },
          finishedAt: Date.now(),
        };
      } else if (msg.type === 'error') {
        organizeJob = { ...organizeJob, state: 'error', error: String(msg.message ?? 'worker error'), finishedAt: Date.now() };
      }
    }
  });

  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  child.on('error', (e) => {
    organizeJob = { ...organizeJob, state: 'error', error: e.message, finishedAt: Date.now() };
    organizeChild = null;
  });
  child.on('exit', (code, signal) => {
    organizeChild = null;
    if (organizeJob.state === 'running') {
      // exited without a terminal message
      if (signal) {
        organizeJob = { ...organizeJob, state: 'cancelled', phase: 'cancelled', finishedAt: Date.now() };
      } else {
        organizeJob = {
          ...organizeJob,
          state: code === 0 ? 'done' : 'error',
          phase: 'exited',
          ...(code === 0 ? {} : { error: stderr.trim().slice(-500) || `worker exited with code ${code}` }),
          finishedAt: Date.now(),
        };
      }
    }
  });
}

/** Stop a running organize child process. */
function cancelOrganize(): boolean {
  if (organizeChild && organizeJob.state === 'running') {
    organizeChild.kill();
    return true;
  }
  return false;
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
    const underRoot = isUnderRoot(root, rawPath);
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

/** Extensions the browser <audio> element can actually decode. WMA/APE are indexed but not playable. */
const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
};

/** Attach an error handler so a mid-stream read failure ends the response instead of crashing. */
function pipeSafe(stream: ReturnType<typeof createReadStream>, res: ServerResponse): void {
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  });
  stream.pipe(res);
}

/**
 * GET /api/audio?path= — stream an indexed track with HTTP Range support so the player can seek.
 * READ-ONLY and confined exactly like /api/cover: the path must resolve under the indexed root AND
 * exactly match a row in `tracks`. Anything else is refused (defeats ../ traversal / arbitrary reads).
 * The source file is only ever read.
 */
async function serveAudio(
  db: Database.Database,
  req: IncomingMessage,
  res: ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  const rawPath = params.get('path');
  if (!rawPath) return json(res, 400, { ok: false, error: 'no_path' });

  const root = meta<{ root?: string }>(db, 'overview')?.root;
  const underRoot = isUnderRoot(root, rawPath);
  const known = db.prepare('SELECT 1 FROM tracks WHERE path = ?').get(rawPath) as unknown;
  if (!underRoot || !known) return json(res, 404, { ok: false, error: 'track_not_found' });

  const ext = (rawPath.split('.').pop() ?? '').toLowerCase();
  const type = AUDIO_MIME[ext];
  if (!type) return json(res, 415, { ok: false, error: 'unsupported_audio', ext });

  let size: number;
  try {
    size = (await stat(rawPath)).size;
  } catch {
    return json(res, 404, { ok: false, error: 'file_missing' });
  }

  const range = req.headers.range;
  const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
  if (m) {
    let start = Number(m[1]);
    let end = m[2] ? Number(m[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
      pipeSafe(createReadStream(rawPath), res);
      return;
    }
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    pipeSafe(createReadStream(rawPath, { start, end }), res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
    pipeSafe(createReadStream(rawPath), res);
  }
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

  if (path === '/api/organize/simulate' && method === 'POST') {
    const b = await readBody(req);
    const source = String(b.source ?? '').trim();
    if (!source) return json(res, 400, { ok: false, error: 'no_source' });
    return json(res, 200, await simulateSchemes(source));
  }
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
  if (path === '/api/organize/cancel' && method === 'POST') {
    const ok = cancelOrganize();
    return json(res, ok ? 200 : 409, { ok, job: organizeJob });
  }

  // ---- read endpoints ----
  if (path === '/api/overview') return overview(db, res);
  if (path === '/api/artists') return artists(db, res);
  if (path === '/api/cover') return cover(db, res, url.searchParams);
  if (path === '/api/audio') return serveAudio(db, req, res, url.searchParams);

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
