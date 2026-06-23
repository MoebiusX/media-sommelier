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
import { mkdirSync, createReadStream, existsSync } from 'node:fs';
import { stat, mkdir, writeFile, rename, unlink, copyFile, rm } from 'node:fs/promises';
import { dirname, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import {
  readCover,
  readLyrics,
  parseLrc,
  readReplayGain,
  autoDj,
  classifyGenre,
  isMood,
  isStyleFamily,
  STYLE_LABELS,
  MOOD_LABELS,
  type DjTrack,
  type Mood,
  type StyleFamily,
  walkToArray,
  reconstruct,
  groupByMetadata,
  planOrganize,
  executePlan,
  sanitizeSegment,
  MusicBrainzClient,
  selectBestRelease,
  artistCreditName,
  extractTracklist,
  normalize,
  ORGANIZE_PRESETS,
  type OrganizePlan,
  type OrganizeAction,
  type TrackTags,
  type AlbumCandidate,
} from '../engine/index.js';
import { ingest } from './ingest.js';
import { JobService, type JobCtx } from './jobs.js';

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
  // Sync profiles: a named subset of the library mirrored to an external drive. Independent of the
  // derived tracks/albums tables (ingest's clearAll never touches these). albumId is a plain TEXT join
  // (NOT a foreign key) so re-ingest can freely DELETE+repopulate albums without a constraint error;
  // album ids are deterministic slugs, so a saved profile re-joins after a re-scan.
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      target      TEXT    NOT NULL DEFAULT '',
      preset      TEXT    NOT NULL DEFAULT 'artist-year-album',
      transcodeTo TEXT    NOT NULL DEFAULT 'none',
      createdAt   INTEGER NOT NULL DEFAULT 0,
      lastSyncAt  INTEGER
    );
    CREATE TABLE IF NOT EXISTS profile_members (
      profileId INTEGER NOT NULL,
      albumId   TEXT    NOT NULL,
      addedAt   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (profileId, albumId)
    );
    -- Online metadata/cover refreshes (MusicBrainz + Cover Art Archive). Durable across re-ingest:
    -- clearAll never touches this, /api/cover serves coverPath from here, and ingest re-applies
    -- title/year. albumId is a deterministic slug so an override re-binds after a re-scan.
    CREATE TABLE IF NOT EXISTS album_overrides (
      albumId   TEXT PRIMARY KEY,
      title     TEXT,
      year      INTEGER,
      coverPath TEXT,
      mbid      TEXT,
      fetchedAt INTEGER NOT NULL DEFAULT 0
    );
    -- Enrichment ledger: one row per album we've ATTEMPTED to look up online. Caches the MusicBrainz
    -- decision + Cover Art Archive result so a re-run (or a resumed/cancelled sweep) skips the network
    -- for everything already tried. This ledger IS the sweep's resume cursor.
    CREATE TABLE IF NOT EXISTS album_enrich (
      albumId     TEXT PRIMARY KEY,
      attemptedAt INTEGER NOT NULL,
      matched     INTEGER NOT NULL,       -- 1 if MusicBrainz returned a usable match
      mbid        TEXT,
      rgMbid      TEXT,
      matchArtist TEXT,
      matchAlbum  TEXT,
      matchYear   INTEGER,
      score       REAL,
      coverState  TEXT                    -- 'found' | 'none' (Cover Art Archive), NULL until checked
    );
    -- Listening playlists. Tracks are referenced by PATH (stable across re-ingest; track ids are not),
    -- so a playlist survives a re-scan; entries for deleted files simply drop out of the join.
    CREATE TABLE IF NOT EXISTS playlists (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT    NOT NULL,
      rules     TEXT,
      createdAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlistId INTEGER NOT NULL,
      trackPath  TEXT    NOT NULL,
      position   INTEGER NOT NULL,
      PRIMARY KEY (playlistId, trackPath)
    );
  `);
  // Lightweight migrations for columns added after a table first shipped (ALTER throws if it exists).
  for (const alter of [
    `ALTER TABLE profiles ADD COLUMN transcodeTo TEXT NOT NULL DEFAULT 'none'`,
    `ALTER TABLE playlists ADD COLUMN rules TEXT`,
  ]) {
    try {
      db.exec(alter);
    } catch {
      /* column already present */
    }
  }
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
  profileId?: number;
  phase: string;
  done: number;
  total: number;
  pid?: number;
  result?: unknown;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** Durable job runtime (scan/sync/organize/refresh). Assigned in start(); see jobs.ts. */
let jobs: JobService;
const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'organize-worker.ts');

/** The 'scan' job handler: index a folder into SQLite (point-at-a-folder control). */
async function scanHandler(ctx: JobCtx): Promise<unknown> {
  const { source } = ctx.params as { source: string };
  reportCache.delete(source); // re-indexing implies the folder may have changed — drop the cached walk
  ctx.progress(0, 0, 'walking folder + reading tags');
  return ingest(source, undefined, (done, total) => ctx.progress(done, total, 'reading tags'));
}

/** Map the latest 'scan' job to the ScanStatus shape the UI expects. */
function scanStatusPayload(): {
  state: 'idle' | 'running' | 'done' | 'error';
  source?: string;
  phase: string;
  done: number;
  total: number;
  result?: unknown;
  error?: string;
} {
  const j = jobs.latest('scan');
  if (!j) return { state: 'idle', phase: '', done: 0, total: 0 };
  const params = j.params as { source?: string };
  const state = j.state === 'running' ? 'running' : j.state === 'done' || j.state === 'cancelled' ? 'done' : 'error';
  return {
    state,
    ...(params?.source ? { source: params.source } : {}),
    phase: j.phase,
    done: j.done,
    total: j.total,
    ...(j.result ? { result: j.result } : {}),
    ...(j.state === 'paused' ? { error: 'interrupted by a restart' } : j.error ? { error: j.error } : {}),
  };
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

/* ---- metadata reconstruction: group the indexed catalog by embedded album tags (vs folders) ----
 * Folder reconstruct() groups by where files live; this groups by what their tags say, so an album
 * scattered across folders is made whole ("integrated"). Runs over the already-indexed `tracks` table
 * (tag-rich), so it's instant and needs no re-walk. READ-ONLY. */
function reconstructMetadata(db: Database.Database, res: ServerResponse): void {
  const rows = db
    .prepare('SELECT path, artistName AS artist, album, title, trackNo, discNo, year FROM tracks')
    .all() as Array<{
    path: string;
    artist: string | null;
    album: string | null;
    title: string | null;
    trackNo: number | null;
    discNo: number | null;
    year: number | null;
  }>;
  const grouping = groupByMetadata(rows);
  const folderAlbums = (db.prepare('SELECT COUNT(*) AS n FROM albums').get() as { n: number }).n;
  const integrated = grouping.albums.filter((a) => a.integrated);
  json(res, 200, {
    stats: grouping.stats,
    folderAlbums,
    integratedTotal: integrated.length,
    integrated: integrated.slice(0, 100), // cap payload; stats cover the rest
  });
}

/* ===================== sync profiles (a hand-picked subset → an external drive) =====================
 * A profile is a set of album ids + a target drive + a naming scheme. Sync is ADDITIVE: it copies the
 * profile's tracks to the drive (hash-verified + idempotent via executePlan — existing files are
 * skipped) and never deletes. Source media is only read. Album ids are deterministic slugs, so a saved
 * profile survives a re-ingest. */

interface ProfileRow {
  id: number;
  name: string;
  target: string;
  preset: string;
  transcodeTo: string; // 'none' | 'mp3'
  createdAt: number;
  lastSyncAt: number | null;
}

/** Resolve the ffmpeg binary: FFMPEG_PATH env → bundled ffmpeg-static → bare name on PATH. */
function ffmpegPath(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  try {
    const p = createRequire(import.meta.url)('ffmpeg-static') as string | null;
    if (p && existsSync(p)) return p;
  } catch {
    /* fall through to PATH */
  }
  return exe;
}

interface SyncTrackRow {
  path: string;
  title: string;
  trackArtist: string | null;
  trackNo: number | null;
  discNo: number | null;
  albumId: string;
  albumArtist: string;
  albumTitle: string;
  year: number | null;
  discCount: number;
  sizeBytes: number;
}

const extLower = (p: string): string => {
  const i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i + 1).toLowerCase() : '';
};
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Formats most car heads / basic players can't decode — surfaced as a warning (still copied as-is). */
const PLAYBACK_RISK_EXT = new Set(['flac', 'ape', 'wav', 'aiff', 'aif', 'alac', 'wv', 'tta', 'tak', 'ogg', 'opus']);

/** Render a destination relative path for one track under a naming template (mirrors the engine renderer). */
function renderProfilePath(tpl: string, r: SyncTrackRow): string {
  const multiDisc = (r.discCount ?? 1) > 1;
  const vals: Record<string, string> = {
    albumArtist: sanitizeSegment(r.albumArtist || 'Unknown Artist'),
    artist: sanitizeSegment(r.trackArtist || r.albumArtist || 'Unknown Artist'),
    album: sanitizeSegment(r.albumTitle || 'Unknown Album'),
    title: sanitizeSegment(r.title || `Track ${r.trackNo ?? ''}`),
    year: r.year ? String(r.year) : '',
    disc: multiDisc ? `Disc ${r.discNo ?? 1}` : '',
    track: pad2(r.trackNo ?? 0),
  };
  const rendered = tpl.replace(/\{(\w+)\}/g, (_, k: string) => (k in vals ? vals[k]! : ''));
  const segs = rendered.split('/').map((s) => s.replace(/\s{2,}/g, ' ').trim()).filter((s) => s.length > 0);
  if (multiDisc && !tpl.includes('{disc}') && segs.length > 0) {
    const file = segs.pop()!;
    segs.push(`Disc ${r.discNo ?? 1}`, file);
  }
  return segs.join('/');
}

/** Every track belonging to a profile's member albums, ordered for a tidy copy. */
function profileTracks(db: Database.Database, profileId: number): SyncTrackRow[] {
  return db
    .prepare(
      `SELECT t.path, t.title, t.artistName AS trackArtist, t.trackNo, t.discNo, t.sizeBytes,
              a.id AS albumId, a.artistName AS albumArtist, a.title AS albumTitle, a.year, a.discCount
       FROM tracks t JOIN albums a ON a.id = t.albumId
       WHERE t.albumId IN (SELECT albumId FROM profile_members WHERE profileId = ?)
       ORDER BY a.artistName, a.year, a.title, COALESCE(t.discNo,1), COALESCE(t.trackNo,9999), t.title`,
    )
    .all(profileId) as SyncTrackRow[];
}

/** Build an additive copy plan (no deletes) from a profile's tracks to its target drive. */
function buildSyncPlan(rows: SyncTrackRow[], target: string, preset: string): OrganizePlan {
  const template = ORGANIZE_PRESETS[preset]?.template ?? ORGANIZE_PRESETS['artist-year-album']!.template;
  const actions: OrganizeAction[] = [];
  const skipped: OrganizePlan['skipped'] = [];
  const destSeen = new Map<string, string[]>();
  for (const r of rows) {
    const rel = renderProfilePath(template, r);
    if (!rel) {
      skipped.push({ candidateId: r.albumId, reason: 'template produced an empty path' });
      continue;
    }
    const ext = extLower(r.path);
    const destRelPath = rel + (ext ? `.${ext}` : '');
    const destPath = `${target}/${destRelPath}`;
    const tags: TrackTags = {
      title: r.title,
      album: r.albumTitle,
      albumArtist: r.albumArtist,
      artist: r.trackArtist || r.albumArtist,
      ...(r.year != null ? { year: r.year } : {}),
      trackNo: r.trackNo ?? 0,
      discNo: r.discNo ?? 1,
      discCount: r.discCount ?? 1,
    };
    actions.push({ candidateId: r.albumId, sourcePath: r.path, destRelPath, destPath, tags });
    if (!destSeen.has(destRelPath)) destSeen.set(destRelPath, []);
    destSeen.get(destRelPath)!.push(r.path);
  }
  const collisions = [...destSeen.entries()]
    .filter(([, s]) => s.length > 1)
    .map(([destRelPath, sources]) => ({ destRelPath, sources }));
  return { destRoot: target, actions, collisions, skipped };
}

/** Format breakdown + playback-risk count for a set of tracks (the car-compat warning). */
function formatBreakdown(rows: SyncTrackRow[]): { formats: Record<string, number>; riskTracks: number } {
  const formats: Record<string, number> = {};
  let riskTracks = 0;
  for (const r of rows) {
    const e = extLower(r.path) || 'other';
    formats[e] = (formats[e] ?? 0) + 1;
    if (PLAYBACK_RISK_EXT.has(e)) riskTracks++;
  }
  return { formats, riskTracks };
}

/** Profile list with rolled-up album/track/byte counts. */
function listProfiles(db: Database.Database): unknown {
  return db
    .prepare(
      `SELECT p.id, p.name, p.target, p.preset, p.transcodeTo, p.createdAt, p.lastSyncAt,
        (SELECT COUNT(*) FROM profile_members m WHERE m.profileId = p.id) AS albumCount,
        (SELECT COUNT(*) FROM tracks t WHERE t.albumId IN (SELECT albumId FROM profile_members WHERE profileId = p.id)) AS trackCount,
        (SELECT COALESCE(SUM(sizeBytes),0) FROM tracks t WHERE t.albumId IN (SELECT albumId FROM profile_members WHERE profileId = p.id)) AS bytes
       FROM profiles p ORDER BY p.createdAt ASC, p.id ASC`,
    )
    .all();
}

/** One profile with its member albums, format breakdown and total size. */
function profileDetail(db: Database.Database, id: number): unknown {
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow | undefined;
  if (!p) return null;
  const albums = db
    .prepare(
      `SELECT a.id, a.title, a.artistName, a.year, a.trackCount, a.sizeBytes, a.lossless, a.coverPath
       FROM profile_members m JOIN albums a ON a.id = m.albumId
       WHERE m.profileId = ? ORDER BY a.artistName, a.year, a.title`,
    )
    .all(id) as Array<{ sizeBytes: number; lossless: number; [k: string]: unknown }>;
  const rows = profileTracks(db, id);
  const { formats, riskTracks } = formatBreakdown(rows);
  const bytes = albums.reduce((n, a) => n + (a.sizeBytes ?? 0), 0);
  return {
    ...p,
    albums: albums.map((a) => ({ ...a, lossless: a.lossless === 1 })),
    trackCount: rows.length,
    bytes,
    formats,
    riskTracks,
  };
}

/** The 'sync' job handler: additive copy of a profile to its target drive (validated by the endpoint). */
async function syncHandler(db: Database.Database, ctx: JobCtx): Promise<unknown> {
  const { profileId } = ctx.params as { profileId: number };
  const prof = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as ProfileRow;
  const rows = profileTracks(db, profileId);
  const libRoot = meta<{ root?: string }>(db, 'overview')?.root;

  let result: unknown;
  if (prof.transcodeTo === 'mp3') {
    result = await transcodeSync(rows, prof.target, prof.preset, libRoot, ctx);
  } else {
    const plan = buildSyncPlan(rows, prof.target, prof.preset);
    ctx.progress(0, plan.actions.length, 'copying');
    const report = await executePlan(plan, {
      ...(libRoot ? { sourceRoot: libRoot } : {}),
      onProgress: (done, total) => ctx.progress(done, total, 'copying'),
    });
    result = { copied: report.copied, skipped: report.skipped, failed: report.failed, bytes: report.bytesCopied, dest: prof.target };
  }
  db.prepare('UPDATE profiles SET lastSyncAt = ? WHERE id = ?').run(Date.now(), profileId);
  return result;
}

/**
 * Transcode-aware sync: lossless / car-incompatible sources are re-encoded to MP3 320k via ffmpeg;
 * everything else is copied as-is. Idempotent (existing dest is skipped), atomic (write temp → rename),
 * dest-must-be-outside-source guarded, cancellable. SOURCE IS ONLY READ.
 */
async function transcodeSync(
  rows: SyncTrackRow[],
  target: string,
  preset: string,
  libRoot: string | undefined,
  ctx: JobCtx,
): Promise<{ copied: number; transcoded: number; skipped: number; failed: number; bytes: number; dest: string }> {
  if (libRoot && (isUnderRoot(libRoot, target) || isUnderRoot(target, libRoot) || resolve(libRoot) === resolve(target))) {
    throw new Error(`Refusing to sync: destination "${target}" overlaps the library "${libRoot}".`);
  }
  const template = ORGANIZE_PRESETS[preset]?.template ?? ORGANIZE_PRESETS['artist-year-album']!.template;
  const ffmpeg = ffmpegPath();
  const tasks = rows.map((r) => {
    const rel = renderProfilePath(template, r);
    const srcExt = extLower(r.path);
    const transcode = PLAYBACK_RISK_EXT.has(srcExt); // lossless / incompatible → MP3
    const ext = transcode ? 'mp3' : srcExt;
    return { src: r.path, dest: join(target, rel + (ext ? `.${ext}` : '')), transcode };
  });

  let copied = 0;
  let transcoded = 0;
  let skipped = 0;
  let failed = 0;
  let bytes = 0;
  ctx.progress(0, tasks.length, 'converting + copying');
  for (let i = 0; i < tasks.length; i++) {
    if (ctx.cancelled()) break;
    const t = tasks[i]!;
    if (existsSync(t.dest)) {
      skipped++;
      ctx.progress(i + 1, tasks.length, 'converting + copying');
      continue;
    }
    const tmp = `${t.dest}.somm-${process.pid}.tmp${t.transcode ? '.mp3' : ''}`;
    try {
      await mkdir(dirname(t.dest), { recursive: true });
      if (t.transcode) {
        // -map 0:a:0 drops embedded art (FLAC pictures can break the encode); tags preserved.
        await execFileAsync(
          ffmpeg,
          ['-y', '-i', t.src, '-map', '0:a:0', '-map_metadata', '0', '-id3v2_version', '3', '-b:a', '320k', tmp],
          { timeout: 300_000 },
        );
        transcoded++;
      } else {
        await copyFile(t.src, tmp);
        copied++;
      }
      await rename(tmp, t.dest);
      bytes += (await stat(t.dest)).size;
    } catch {
      failed++;
      await rm(tmp, { force: true }).catch(() => {});
    }
    ctx.progress(i + 1, tasks.length, 'converting + copying');
  }
  return { copied: copied + transcoded, transcoded, skipped, failed, bytes, dest: target };
}

/** Validate a sync request up front (so the POST can reject synchronously like the UI expects). */
function syncPreflight(db: Database.Database, id: number): { error?: string; status?: number } {
  if (jobs.latest('sync')?.state === 'running') return { error: 'sync_in_progress', status: 409 };
  const prof = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow | undefined;
  if (!prof) return { error: 'profile_not_found', status: 404 };
  if (!prof.target.trim()) return { error: 'no_target', status: 400 };
  if (profileTracks(db, id).length === 0) return { error: 'empty_profile', status: 400 };
  return {};
}

/** Map the latest 'sync' job to the SyncStatus shape the Drives UI expects. */
function syncStatusPayload(): {
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  profileId?: number;
  dest?: string;
  phase: string;
  done: number;
  total: number;
  result?: unknown;
  error?: string;
} {
  const j = jobs.latest('sync');
  if (!j) return { state: 'idle', phase: '', done: 0, total: 0 };
  const params = j.params as { profileId?: number };
  const result = j.result as { dest?: string } | null;
  const state = j.state === 'running' ? 'running' : j.state === 'done' ? 'done' : j.state === 'cancelled' ? 'cancelled' : 'error';
  return {
    state,
    ...(params?.profileId != null ? { profileId: params.profileId } : {}),
    ...(result?.dest ? { dest: result.dest } : {}),
    phase: j.phase,
    done: j.done,
    total: j.total,
    ...(j.result ? { result: j.result } : {}),
    ...(j.state === 'paused' ? { error: 'interrupted by a restart' } : j.error ? { error: j.error } : {}),
  };
}

/* ============= online refresh (MusicBrainz + Cover Art Archive) =============
 * "Refresh metadata/cover" looks an album up on MusicBrainz, fetches front cover art from the Cover
 * Art Archive, and — on the user's confirm — applies canonical title/year + the cover. SOURCE MEDIA IS
 * NEVER WRITTEN: covers cache under data/covers and the only mutation is the DB index. Applied changes
 * live in album_overrides (durable across re-ingest; /api/cover serves their cover, ingest re-applies
 * title/year). */

const COVER_DIR = 'data/covers';
const CAA_UA = 'MediaSommelier/0.1.0 ( https://github.com/MoebiusX/media-sommelier )';
const mbClient = new MusicBrainzClient({ cacheDir: 'data/mb-cache' });
const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');
const pendingCoverPath = (albumId: string): string => join(COVER_DIR, `${sha1(albumId)}.pending.jpg`);
const finalCoverPath = (albumId: string): string => join(COVER_DIR, `${sha1(albumId)}.jpg`);

interface RefreshMatch {
  mbid: string;
  releaseGroupMbid?: string;
  artist: string;
  album: string;
  year?: number;
  trackCount?: number;
  score: number;
}

/** Look an indexed album up on MusicBrainz; return the best scored release match (or null). */
async function lookupAlbum(album: { artistName: string; title: string; trackCount: number }): Promise<RefreshMatch | null> {
  const releases = await mbClient.searchReleases(album.artistName, album.title);
  if (releases.length === 0) return null;
  const partial = { albumTitle: album.title, albumArtist: album.artistName, totalTracks: album.trackCount } as AlbumCandidate;
  const best = selectBestRelease(partial, releases, 0.45);
  if (!best) return null;
  const r = best.release;
  const ym = r.date?.match(/^(\d{4})/);
  return {
    mbid: r.id,
    ...(r['release-group']?.id ? { releaseGroupMbid: r['release-group'].id } : {}),
    artist: artistCreditName(r) || album.artistName,
    album: r.title,
    ...(ym ? { year: Number(ym[1]) } : {}),
    ...(r['track-count'] != null ? { trackCount: r['track-count'] } : {}),
    score: Math.round(best.score * 100) / 100,
  };
}

/** Fetch a 500px front cover from the Cover Art Archive (release, then release-group). JPEG bytes or null. */
async function fetchFrontCover(m: { mbid: string; releaseGroupMbid?: string }): Promise<Buffer | null> {
  const urls = [
    `https://coverartarchive.org/release/${m.mbid}/front-500`,
    ...(m.releaseGroupMbid ? [`https://coverartarchive.org/release-group/${m.releaseGroupMbid}/front-500`] : []),
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers: { 'User-Agent': CAA_UA } });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 0) return buf;
      }
    } catch {
      /* try next source */
    }
  }
  return null;
}

interface EnrichLedgerRow {
  albumId: string;
  matched: number;
  mbid: string | null;
  rgMbid: string | null;
  matchArtist: string | null;
  matchAlbum: string | null;
  matchYear: number | null;
  score: number | null;
  coverState: string | null;
}

const readLedger = (db: Database.Database, albumId: string): EnrichLedgerRow | undefined =>
  db.prepare('SELECT * FROM album_enrich WHERE albumId = ?').get(albumId) as EnrichLedgerRow | undefined;

/** Record a fresh lookup attempt. coverState resets to NULL (re-evaluated by ensurePendingCover). */
function writeLedger(db: Database.Database, albumId: string, match: RefreshMatch | null): void {
  db.prepare(
    `INSERT INTO album_enrich(albumId,attemptedAt,matched,mbid,rgMbid,matchArtist,matchAlbum,matchYear,score,coverState)
     VALUES(@albumId,@now,@matched,@mbid,@rgMbid,@matchArtist,@matchAlbum,@matchYear,@score,NULL)
     ON CONFLICT(albumId) DO UPDATE SET
       attemptedAt=@now, matched=@matched, mbid=@mbid, rgMbid=@rgMbid,
       matchArtist=@matchArtist, matchAlbum=@matchAlbum, matchYear=@matchYear, score=@score, coverState=NULL`,
  ).run({
    albumId,
    now: Date.now(),
    matched: match ? 1 : 0,
    mbid: match?.mbid ?? null,
    rgMbid: match?.releaseGroupMbid ?? null,
    matchArtist: match?.artist ?? null,
    matchAlbum: match?.album ?? null,
    matchYear: match?.year ?? null,
    score: match?.score ?? null,
  });
}

const setCoverState = (db: Database.Database, albumId: string, state: 'found' | 'none'): void => {
  db.prepare('UPDATE album_enrich SET coverState = ? WHERE albumId = ?').run(state, albumId);
};

/** Look an album up, preferring the cached ledger decision. Only `force` (or a cache miss) hits MusicBrainz. */
async function cachedLookup(
  db: Database.Database,
  albumId: string,
  album: { artistName: string; title: string; trackCount: number },
  force: boolean,
): Promise<RefreshMatch | null> {
  if (!force) {
    const row = readLedger(db, albumId);
    if (row) {
      if (!row.matched) return null;
      return {
        mbid: row.mbid!,
        ...(row.rgMbid ? { releaseGroupMbid: row.rgMbid } : {}),
        artist: row.matchArtist ?? album.artistName,
        album: row.matchAlbum ?? album.title,
        ...(row.matchYear != null ? { year: row.matchYear } : {}),
        score: row.score ?? 0,
      };
    }
  }
  const match = await lookupAlbum(album);
  writeLedger(db, albumId, match);
  return match;
}

/** Ensure a pending cover exists for a match, using the staged file or the CAA negative cache when possible. */
async function ensurePendingCover(db: Database.Database, albumId: string, match: RefreshMatch): Promise<boolean> {
  if (existsSync(pendingCoverPath(albumId))) return true; // already staged this session
  if (readLedger(db, albumId)?.coverState === 'none') return false; // negative cache — don't re-hit CAA
  const cover = await fetchFrontCover(match);
  if (cover) {
    await mkdir(COVER_DIR, { recursive: true });
    await writeFile(pendingCoverPath(albumId), cover);
    setCoverState(db, albumId, 'found');
    return true;
  }
  setCoverState(db, albumId, 'none');
  return false;
}

/** Cache-aware enrichment for one album (no DB album-row fetch — caller supplies the fields). */
async function enrichOne(
  db: Database.Database,
  album: { id: string; artistName: string; title: string; trackCount: number },
  force: boolean,
): Promise<{ matched: boolean; match?: RefreshMatch; coverFetched: boolean }> {
  const match = await cachedLookup(db, album.id, { artistName: album.artistName, title: album.title, trackCount: album.trackCount }, force);
  if (!match) return { matched: false, coverFetched: false };
  const coverFetched = await ensurePendingCover(db, album.id, match);
  return { matched: true, match, coverFetched };
}

/** Per-album refresh (the album-page button): cache-aware lookup + staged cover. */
async function refreshAlbum(
  db: Database.Database,
  albumId: string,
  force = false,
): Promise<{ matched: boolean; before: { title: string; year: number | null }; match?: RefreshMatch; coverFetched: boolean } | null> {
  const al = db.prepare('SELECT id, title, artistName, year, trackCount FROM albums WHERE id = ?').get(albumId) as
    | { id: string; title: string; artistName: string; year: number | null; trackCount: number }
    | undefined;
  if (!al) return null;
  const before = { title: al.title, year: al.year };
  const r = await enrichOne(db, al, force);
  return { matched: r.matched, before, ...(r.match ? { match: r.match } : {}), coverFetched: r.coverFetched };
}

/** Commit a refresh: stage cover → final, upsert the durable override, update the live album row. */
async function applyRefresh(
  db: Database.Database,
  albumId: string,
  opts: { title?: string; year?: number; cover?: boolean; mbid?: string },
): Promise<void> {
  let coverPath: string | null = null;
  if (opts.cover) {
    const pend = pendingCoverPath(albumId);
    if (existsSync(pend)) {
      await mkdir(COVER_DIR, { recursive: true });
      const fin = finalCoverPath(albumId);
      await rename(pend, fin);
      coverPath = fin;
    }
  }
  db.prepare(
    `INSERT INTO album_overrides(albumId,title,year,coverPath,mbid,fetchedAt)
     VALUES(@albumId,@title,@year,@coverPath,@mbid,@now)
     ON CONFLICT(albumId) DO UPDATE SET
       title=COALESCE(excluded.title, title),
       year=COALESCE(excluded.year, year),
       coverPath=COALESCE(excluded.coverPath, coverPath),
       mbid=COALESCE(excluded.mbid, mbid),
       fetchedAt=excluded.fetchedAt`,
  ).run({
    albumId,
    title: opts.title ?? null,
    year: opts.year ?? null,
    coverPath,
    mbid: opts.mbid ?? null,
    now: Date.now(),
  });
  if (opts.title != null || opts.year != null) {
    db.prepare('UPDATE albums SET title=COALESCE(?,title), year=COALESCE(?,year) WHERE id=?').run(
      opts.title ?? null,
      opts.year ?? null,
      albumId,
    );
  }
}

/** Title key tolerant of "(Remaster)"/"[Live]" suffixes, for matching a local track to a MB tracklist. */
const trackKey = (s: string | null): string => normalize((s ?? '').replace(/[([{][^)\]}]*[)\]}]/g, ' '));

/**
 * Compare an album against its MusicBrainz release tracklist to find MISSING tracks (the SOTA
 * "complete your albums" view). Uses the enrich ledger's mbid when present, else a lookup; then the
 * release's full tracklist (MB-cached). Read-only — surfaces gaps, downloads nothing.
 */
async function albumCompleteness(
  db: Database.Database,
  albumId: string,
): Promise<{
  matched: boolean;
  mbAlbum?: string;
  expected?: number;
  have?: number;
  missing?: Array<{ disc: number; position: number; title: string }>;
  extra?: Array<{ title: string; trackNo: number | null; discNo: number | null }>;
} | null> {
  const al = db.prepare('SELECT id, title, artistName, trackCount FROM albums WHERE id = ?').get(albumId) as
    | { id: string; title: string; artistName: string; trackCount: number }
    | undefined;
  if (!al) return null;
  let mbid = (db.prepare('SELECT mbid FROM album_enrich WHERE albumId = ? AND matched = 1').get(albumId) as { mbid: string | null } | undefined)?.mbid ?? null;
  if (!mbid) {
    const m = await cachedLookup(db, albumId, { artistName: al.artistName, title: al.title, trackCount: al.trackCount }, false);
    mbid = m?.mbid ?? null;
  }
  if (!mbid) return { matched: false };
  const rel = await mbClient.getRelease(mbid);
  const mbTracks = extractTracklist(rel);
  if (mbTracks.length === 0) return { matched: false };
  const myTracks = db.prepare('SELECT title, trackNo, discNo FROM tracks WHERE albumId = ?').all(albumId) as Array<{ title: string; trackNo: number | null; discNo: number | null }>;
  const have = new Set(myTracks.map((t) => trackKey(t.title)));
  const mbKeys = new Set(mbTracks.map((t) => trackKey(t.title)));
  const missing = mbTracks.filter((mb) => !have.has(trackKey(mb.title)));
  const extra = myTracks.filter((t) => !mbKeys.has(trackKey(t.title))).map((t) => ({ title: t.title, trackNo: t.trackNo, discNo: t.discNo }));
  return { matched: true, mbAlbum: rel?.title ?? al.title, expected: mbTracks.length, have: myTracks.length, missing, extra };
}

/* ---- smart playlists: a rule set evaluated live against the tracks table ---- */
interface SmartCondition {
  field: string;
  op: string;
  value: string;
}
interface SmartRules {
  match?: 'all' | 'any';
  conditions?: SmartCondition[];
  sort?: string;
  limit?: number;
}

/** Evaluate a smart-playlist rule set into live track rows (parameterized — values never interpolated). */
function smartTracks(db: Database.Database, rules: SmartRules): Array<Record<string, unknown>> {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  for (const c of rules.conditions ?? []) {
    const v = String(c.value ?? '');
    if (c.field === 'genre') {
      clauses.push("lower(COALESCE(genre,'')) LIKE ?");
      params.push(`%${v.toLowerCase()}%`);
    } else if (c.field === 'artist') {
      clauses.push("lower(COALESCE(artistName,'')) LIKE ?");
      params.push(`%${v.toLowerCase()}%`);
    } else if (c.field === 'album') {
      clauses.push("lower(COALESCE(album,'')) LIKE ?");
      params.push(`%${v.toLowerCase()}%`);
    } else if (c.field === 'title') {
      clauses.push('lower(title) LIKE ?');
      params.push(`%${v.toLowerCase()}%`);
    } else if (c.field === 'format') {
      clauses.push('lower(path) LIKE ?');
      params.push(`%.${v.toLowerCase()}`);
    } else if (c.field === 'lossless') {
      clauses.push('lossless = ?');
      params.push(v === 'true' || v === '1' ? 1 : 0);
    } else if (c.field === 'year') {
      clauses.push(c.op === 'gte' ? 'year >= ?' : c.op === 'lte' ? 'year <= ?' : 'year = ?');
      params.push(Number(v) || 0);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join((rules.match ?? 'all') === 'any' ? ' OR ' : ' AND ')}` : '';
  const order =
    rules.sort === 'random'
      ? 'ORDER BY RANDOM()'
      : rules.sort === 'year'
        ? 'ORDER BY year DESC, artistName'
        : rules.sort === 'title'
          ? 'ORDER BY title'
          : 'ORDER BY artistName, album, COALESCE(discNo,1), COALESCE(trackNo,9999)';
  const lim = rules.limit && rules.limit > 0 ? Math.min(Number(rules.limit), 2000) : 500;
  const rows = db
    .prepare(
      `SELECT id, title, artistName, album, albumId, path, durationMs, bitrateKbps, lossless, sizeBytes, 0 AS position
       FROM tracks ${where} ${order} LIMIT ${lim}`,
    )
    .all(...params) as Array<{ lossless: number; [k: string]: unknown }>;
  return rows.map((t) => ({ ...t, lossless: t.lossless === 1 }));
}

/* ---- batch refresh: a JobService job ('refresh') that sweeps the library proposing covers/metadata.
 * Each proposal is emitted as a durable job_item, so the review queue survives a restart. ---- */
interface RefreshProposal {
  albumId: string;
  artistName: string;
  title: string;
  year: number | null;
  match: { album: string; year?: number; score: number; mbid: string };
  coverFetched: boolean;
}

/** Candidate albums for a sweep: `onlyMissing` = no folder art and no existing override. */
function selectRefreshCandidates(
  db: Database.Database,
  onlyMissing: boolean,
  limit?: number,
): Array<{ id: string; artistName: string; title: string; year: number | null; trackCount: number }> {
  const noOverride = `a.id NOT IN (SELECT albumId FROM album_overrides)`;
  const where = onlyMissing ? `WHERE ${noOverride} AND (a.coverPath IS NULL OR a.coverPath = '')` : `WHERE ${noOverride}`;
  let rows = db
    .prepare(`SELECT a.id, a.artistName, a.title, a.year, a.trackCount FROM albums a ${where} ORDER BY a.trackCount DESC`)
    .all() as Array<{ id: string; artistName: string; title: string; year: number | null; trackCount: number }>;
  if (limit && limit > 0) rows = rows.slice(0, limit);
  return rows;
}

/** The 'refresh' job handler. Cache-aware via enrichOne(), so a cancelled/crashed sweep resumes for free. */
async function refreshHandler(db: Database.Database, ctx: JobCtx): Promise<unknown> {
  const p = ctx.params as { onlyMissing: boolean; force?: boolean; limit?: number };
  const rows = selectRefreshCandidates(db, p.onlyMissing, p.limit);
  ctx.progress(0, rows.length, 'looking up releases');
  let done = 0;
  let found = 0;
  for (const a of rows) {
    if (ctx.cancelled()) break;
    const r = await enrichOne(db, a, p.force ?? false);
    // Only propose if there's something to gain: a cover or a year we don't already have.
    if (r.matched && r.match && (r.coverFetched || (r.match.year != null && r.match.year !== a.year))) {
      const proposal: RefreshProposal = {
        albumId: a.id,
        artistName: a.artistName,
        title: a.title,
        year: a.year,
        match: { album: r.match.album, ...(r.match.year != null ? { year: r.match.year } : {}), score: r.match.score, mbid: r.match.mbid },
        coverFetched: r.coverFetched,
      };
      ctx.emit(proposal); // durable — survives a restart
      found++;
    }
    ctx.progress(++done, rows.length, 'looking up releases');
  }
  return { found };
}

/** Apply the user-selected subset of proposals; discard the staged covers of the rest. */
async function applyBatch(
  db: Database.Database,
  items: Array<{ albumId: string; title?: string; year?: number; cover?: boolean; mbid?: string }>,
  allProposals: RefreshProposal[],
): Promise<number> {
  const keep = new Set(items.map((i) => i.albumId));
  for (const it of items) {
    await applyRefresh(db, it.albumId, {
      ...(it.title != null ? { title: it.title } : {}),
      ...(it.year != null ? { year: it.year } : {}),
      cover: !!it.cover,
      ...(it.mbid != null ? { mbid: it.mbid } : {}),
    });
  }
  for (const pr of allProposals) {
    if (!keep.has(pr.albumId)) {
      const pp = pendingCoverPath(pr.albumId);
      if (existsSync(pp)) await unlink(pp).catch(() => {});
    }
  }
  return items.length;
}

/** Map the latest 'refresh' job (+ its durable proposals) to the shape the Overview UI expects. */
function refreshStatusPayload(): {
  state: 'idle' | 'running' | 'done' | 'error';
  phase: string;
  done: number;
  total: number;
  proposals: RefreshProposal[];
  error?: string;
} {
  const j = jobs.latest('refresh');
  if (!j) return { state: 'idle', phase: '', done: 0, total: 0, proposals: [] };
  // cancelled/paused (incl. a sweep interrupted by a restart) → 'done' so the gathered review queue shows.
  const state = j.state === 'running' ? 'running' : j.state === 'error' ? 'error' : 'done';
  return {
    state,
    phase: j.phase,
    done: j.done,
    total: j.total,
    proposals: jobs.items(j.id) as RefreshProposal[],
    ...(j.error ? { error: j.error } : {}),
  };
}

/** Everything currently running, for a global "what's running" indicator. All four job types (scan,
 * sync, organize, refresh) now run through the JobService. */
function activeJobs(): Array<{ type: string; phase: string; done: number; total: number }> {
  return jobs.active().map((j) => ({ type: j.type, phase: j.phase, done: j.done, total: j.total }));
}

/**
 * The 'organize' job handler. Spawns the reorg as a CHILD PROCESS so the long copy runs isolated and
 * killable (ctx.onCancel → child.kill); progress streams back over stdout. Originals are never touched —
 * the worker uses executePlan with the dest-outside-source guard.
 */
function organizeHandler(ctx: JobCtx): Promise<unknown> {
  const { source, dest, preset, writeTags } = ctx.params as { source: string; dest: string; preset: string; writeTags: boolean };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER, source, dest, preset, String(writeTags)], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ctx.onCancel(() => child.kill());
    let result: unknown = null;
    let stderr = '';
    let buf = '';
    ctx.progress(0, 0, 'starting worker');
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
          continue; // non-JSON library noise
        }
        if (msg.type === 'plan') ctx.progress(0, Number(msg.actions ?? 0), 'copying');
        else if (msg.type === 'progress') ctx.progress(Number(msg.done ?? 0), Number(msg.total ?? 0), typeof msg.phase === 'string' ? msg.phase : 'copying');
        else if (msg.type === 'done') result = { copied: msg.copied, skipped: msg.skipped, failed: msg.failed, tagged: msg.tagged, bytes: msg.bytes, dest };
        else if (msg.type === 'error') reject(new Error(String(msg.message ?? 'worker error')));
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (e) => reject(e));
    child.on('exit', (code, signal) => {
      if (signal) resolve(result ?? { dest }); // killed (cancelled) — JobService marks it cancelled
      else if (code === 0) resolve(result ?? { copied: 0, dest });
      else reject(new Error(stderr.trim().slice(-500) || `worker exited with code ${code}`));
    });
  });
}

/** Map the latest 'organize' job to the OrganizeStatus shape the UI expects. */
function organizeStatusPayload(): {
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  source?: string;
  dest?: string;
  phase: string;
  done: number;
  total: number;
  result?: unknown;
  error?: string;
} {
  const j = jobs.latest('organize');
  if (!j) return { state: 'idle', phase: '', done: 0, total: 0 };
  const params = j.params as { source?: string; dest?: string };
  const state = j.state === 'running' ? 'running' : j.state === 'done' ? 'done' : j.state === 'cancelled' ? 'cancelled' : 'error';
  return {
    state,
    ...(params?.source ? { source: params.source } : {}),
    ...(params?.dest ? { dest: params.dest } : {}),
    phase: j.phase,
    done: j.done,
    total: j.total,
    ...(j.result ? { result: j.result } : {}),
    ...(j.state === 'paused' ? { error: 'interrupted by a restart' } : j.error ? { error: j.error } : {}),
  };
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

/**
 * GET /api/search?q= — ranked search across artists, albums and tracks. Every whitespace token must
 * match (AND), prefix matches rank first. Cheap LIKE scan (fast at ~10K rows); upgrade to FTS5 if needed.
 */
function search(db: Database.Database, res: ServerResponse, q: string): void {
  const trimmed = q.trim();
  if (trimmed.length < 1) {
    json(res, 200, { artists: [], albums: [], tracks: [] });
    return;
  }
  const esc = (s: string): string => s.replace(/[%_\\]/g, (c) => '\\' + c);
  const tokens = trimmed.split(/\s+/).slice(0, 6);
  const pat = tokens.map((t) => `%${esc(t)}%`); // one %token% per token
  const prefix = `${esc(trimmed)}%`;
  /** WHERE clause: every token must appear in at least one of `cols`. */
  const whereAllTokensIn = (cols: string[]): string =>
    tokens.map(() => '(' + cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')').join(' AND ');
  /** Bind params for whereAllTokensIn: each token repeated once per column. */
  const paramsFor = (nCols: number): string[] => tokens.flatMap((_, i) => Array(nCols).fill(pat[i]));

  const artistRows = db
    .prepare(
      `SELECT name, trackCount, albumCount FROM artists
       WHERE ${whereAllTokensIn(['name'])}
       ORDER BY (name LIKE ? ESCAPE '\\') DESC, trackCount DESC LIMIT 6`,
    )
    .all(...paramsFor(1), prefix);

  const albumRows = db
    .prepare(
      `SELECT id, title, artistName, year, trackCount FROM albums
       WHERE ${whereAllTokensIn(['title', 'artistName'])}
       ORDER BY (title LIKE ? ESCAPE '\\') DESC, trackCount DESC LIMIT 6`,
    )
    .all(...paramsFor(2), prefix);

  const trackRows = db
    .prepare(
      `SELECT id, title, artistName, albumId, path, durationMs FROM tracks
       WHERE ${whereAllTokensIn(['title'])}
       ORDER BY (title LIKE ? ESCAPE '\\') DESC, title ASC LIMIT 8`,
    )
    .all(...paramsFor(1), prefix);

  json(res, 200, { artists: artistRows, albums: albumRows, tracks: trackRows });
}

/**
 * GET /api/duplicates — likely-duplicate tracks (the app's reason for being: messy collections have
 * the same song ripped many times). Groups by normalized title+artist within a ~10s duration bucket;
 * recommends a keeper (lossless > bitrate > size). READ-ONLY — surfaces them; the user decides.
 */
function duplicates(db: Database.Database, res: ServerResponse): void {
  const rows = db
    .prepare(
      `SELECT id, title, artistName, album, albumId, path, durationMs, bitrateKbps, lossless, sizeBytes FROM tracks`,
    )
    .all() as Array<{
    id: number;
    title: string;
    artistName: string | null;
    album: string | null;
    albumId: string | null;
    path: string;
    durationMs: number | null;
    bitrateKbps: number | null;
    lossless: number;
    sizeBytes: number;
  }>;
  const norm = (s: string | null): string =>
    (s ?? '')
      .toLowerCase()
      .replace(/[[(].*$/, '') // drop "(live)", "[remaster]" tails
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const byKey = new Map<string, typeof rows>();
  for (const t of rows) {
    const nt = norm(t.title);
    const na = norm(t.artistName);
    if (nt.length < 2 || !na) continue; // need a real title + a tagged artist to claim a duplicate
    const bucket = t.durationMs ? Math.round(t.durationMs / 10000) : 'x'; // ~10s window separates live/edits
    const key = `${nt}|${na}|${bucket}`;
    const arr = byKey.get(key);
    if (arr) arr.push(t);
    else byKey.set(key, [t]);
  }
  let wastedBytes = 0;
  const groups: Array<unknown> = [];
  for (const ts of byKey.values()) {
    if (ts.length < 2) continue;
    ts.sort(
      (a, b) =>
        b.lossless - a.lossless ||
        (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0) ||
        (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0),
    );
    const keeperId = ts[0]!.id;
    const wasted = ts.slice(1).reduce((n, t) => n + (t.sizeBytes ?? 0), 0);
    wastedBytes += wasted;
    groups.push({
      title: ts[0]!.title,
      artist: ts[0]!.artistName,
      count: ts.length,
      wastedBytes: wasted,
      tracks: ts.map((t) => ({
        id: t.id,
        album: t.album,
        albumId: t.albumId,
        path: t.path,
        durationMs: t.durationMs,
        bitrateKbps: t.bitrateKbps,
        lossless: t.lossless === 1,
        sizeBytes: t.sizeBytes,
        ext: extLower(t.path),
        keeper: t.id === keeperId,
      })),
    });
  }
  (groups as Array<{ wastedBytes: number; count: number }>).sort((a, b) => b.wastedBytes - a.wastedBytes || b.count - a.count);
  json(res, 200, { totalGroups: groups.length, wastedBytes, groups: groups.slice(0, 300) });
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

/** GET /api/albums — every reconstructed album (for the browse-all grid). Sorted/filtered client-side. */
function allAlbums(db: Database.Database, res: ServerResponse): void {
  const rows = db
    .prepare(
      `SELECT id, title, artistName, year, coverPath, trackCount, flags, confidence, lossless, discCount, sizeBytes
       FROM albums ORDER BY artistName ASC, year ASC, title ASC`,
    )
    .all() as Array<{ flags: string; lossless: number; [k: string]: unknown }>;
  json(
    res,
    200,
    rows.map((a) => ({ ...a, flags: JSON.parse(a.flags), lossless: a.lossless === 1 })),
  );
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
  // A refreshed (Cover Art Archive) cover wins over embedded/folder art — serve the cached image directly.
  if (albumId) {
    const ov = db.prepare('SELECT coverPath FROM album_overrides WHERE albumId = ?').get(albumId) as
      | { coverPath: string | null }
      | undefined;
    if (ov?.coverPath && existsSync(ov.coverPath)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=300' });
      pipeSafe(createReadStream(ov.coverPath), res);
      return;
    }
  }
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

/** Source files are immutable for a session, so let the browser cache them — this is what makes the
 *  player's next-track preload (a hidden warmer <audio>) pay off: the bytes are already cached when the
 *  main element advances. private = never shared by a proxy (paths are local + sensitive). */
const AUDIO_CACHE = 'private, max-age=3600';

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
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size, 'Cache-Control': AUDIO_CACHE });
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
      'Cache-Control': AUDIO_CACHE,
    });
    pipeSafe(createReadStream(rawPath, { start, end }), res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size, 'Cache-Control': AUDIO_CACHE });
    pipeSafe(createReadStream(rawPath), res);
  }
}

/* ============================ lyrics (offline-first, online fallback) ============================
 * GET /api/lyrics?path= serves time-synced (karaoke) or plain lyrics for the now-playing track. Local
 * sources first (engine readLyrics: .lrc/.txt sidecar → embedded tags), then — only if nothing local —
 * a graceful lrclib.net lookup (no key, degrades silently when offline; I3). Results are cached in
 * memory per path. SOURCE MEDIA IS ONLY READ; nothing is written to disk. */

const LRCLIB_UA = 'MediaSommelier/0.1.0 ( https://github.com/MoebiusX/media-sommelier )';

interface LyricsPayload {
  ok: boolean;
  source: 'sidecar' | 'embedded' | 'lrclib' | null;
  synced: Array<{ time: number; text: string }> | null;
  plain: string | null;
}

/** Successful lyrics lookups, keyed by track path (misses aren't cached so an offline retry can succeed). */
const lyricsCache = new Map<string, LyricsPayload>();

/** Best-effort lrclib.net lookup (exact get, then search). Returns null on miss / offline / timeout. */
async function fetchLrclib(
  title: string,
  artist: string,
  album: string | null,
  durationMs: number | null,
): Promise<LyricsPayload | null> {
  if (!title || !artist) return null;
  const base = new URLSearchParams({ track_name: title, artist_name: artist });
  if (album) base.set('album_name', album);
  const get = new URLSearchParams(base);
  if (durationMs) get.set('duration', String(Math.round(durationMs / 1000)));
  const urls = [`https://lrclib.net/api/get?${get}`, `https://lrclib.net/api/search?${base}`];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': LRCLIB_UA }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const data = (await r.json()) as unknown;
      const rec = (Array.isArray(data) ? data[0] : data) as { syncedLyrics?: unknown; plainLyrics?: unknown } | undefined;
      if (!rec) continue;
      const syncedText = typeof rec.syncedLyrics === 'string' ? rec.syncedLyrics.trim() : '';
      const synced = syncedText ? parseLrc(syncedText) : [];
      const plainText = typeof rec.plainLyrics === 'string' ? rec.plainLyrics.trim() : '';
      const plain = plainText || (synced.length ? synced.map((l) => l.text).join('\n') : '');
      if (synced.length || plain) return { ok: true, source: 'lrclib', synced: synced.length ? synced : null, plain: plain || null };
    } catch {
      /* offline / timeout / bad JSON — graceful degrade, try next */
    }
  }
  return null;
}

/**
 * GET /api/lyrics?path= — lyrics for an indexed track. Validated exactly like /api/audio (path must
 * resolve under the indexed root AND match a row in `tracks`); refuses anything else.
 */
async function serveLyrics(db: Database.Database, res: ServerResponse, params: URLSearchParams): Promise<void> {
  const rawPath = params.get('path');
  if (!rawPath) return json(res, 400, { ok: false, error: 'no_path' });

  const root = meta<{ root?: string }>(db, 'overview')?.root;
  const row = db.prepare('SELECT title, artistName, album, durationMs FROM tracks WHERE path = ?').get(rawPath) as
    | { title: string; artistName: string | null; album: string | null; durationMs: number | null }
    | undefined;
  if (!isUnderRoot(root, rawPath) || !row) return json(res, 404, { ok: false, error: 'track_not_found' });

  const cached = lyricsCache.get(rawPath);
  if (cached) return json(res, 200, cached);

  const local = await readLyrics(rawPath);
  let payload: LyricsPayload;
  if (local.synced || local.plain) {
    payload = { ok: true, source: local.source, synced: local.synced, plain: local.plain };
  } else {
    payload =
      (await fetchLrclib(row.title, row.artistName ?? '', row.album, row.durationMs)) ??
      { ok: false, source: null, synced: null, plain: null };
  }
  if (payload.ok) lyricsCache.set(rawPath, payload);
  return json(res, 200, payload);
}

/* ============================ loudness (ReplayGain, offline) ============================
 * GET /api/loudness?path= returns the track/album ReplayGain (dB) + sample peaks read from the file's
 * embedded tags, so the player can level-match tracks via a Web Audio gain node. Fully offline (engine
 * readReplayGain), validated like /api/audio, cached per path (tags are static — even a miss is cached so
 * an untagged file isn't re-parsed). SOURCE IS ONLY READ. Untagged files return source:null → no change. */

interface LoudnessPayload {
  ok: boolean;
  trackGainDb: number | null;
  albumGainDb: number | null;
  trackPeak: number | null;
  albumPeak: number | null;
  source: 'tag' | null;
}

const loudnessCache = new Map<string, LoudnessPayload>();

async function serveLoudness(db: Database.Database, res: ServerResponse, params: URLSearchParams): Promise<void> {
  const rawPath = params.get('path');
  if (!rawPath) return json(res, 400, { ok: false, error: 'no_path' });

  const root = meta<{ root?: string }>(db, 'overview')?.root;
  const known = db.prepare('SELECT 1 FROM tracks WHERE path = ?').get(rawPath) as unknown;
  if (!isUnderRoot(root, rawPath) || !known) return json(res, 404, { ok: false, error: 'track_not_found' });

  const cached = loudnessCache.get(rawPath);
  if (cached) return json(res, 200, cached);

  const rg = await readReplayGain(rawPath);
  const payload: LoudnessPayload = { ok: true, ...rg };
  loudnessCache.set(rawPath, payload);
  return json(res, 200, payload);
}

/* ================================ Auto DJ (mood/style radio) ================================
 * Build an endless, mood/style-coherent queue from the catalog. Fully offline (engine `autoDj` over
 * genre tags + era — invariant I3). The pool is every PLAYABLE track (the browser <audio> can't decode
 * .wma/.ape, so we never queue them). SOURCE IS ONLY READ. */

/** Every indexed track the player can actually decode, shaped for the engine sequencer. */
function loadDjPool(db: Database.Database): DjTrack[] {
  const rows = db
    .prepare(
      `SELECT id, path, title, artistName AS artist, album AS albumTitle, albumId, genre, year, durationMs FROM tracks`,
    )
    .all() as Array<{
    id: number;
    path: string;
    title: string;
    artist: string | null;
    albumTitle: string | null;
    albumId: string | null;
    genre: string | null;
    year: number | null;
    durationMs: number | null;
  }>;
  return rows.filter((r) => AUDIO_MIME[extLower(r.path)] != null);
}

/** GET /api/dj/moods — moods + style families present in the (playable) library, with track counts. */
function djMoods(db: Database.Database, res: ServerResponse): void {
  const pool = loadDjPool(db);
  const moods = new Map<Mood, number>();
  const styles = new Map<StyleFamily, number>();
  for (const t of pool) {
    const c = classifyGenre(t.genre);
    if (!c) continue;
    moods.set(c.mood, (moods.get(c.mood) ?? 0) + 1);
    styles.set(c.style, (styles.get(c.style) ?? 0) + 1);
  }
  const toArr = <K extends string>(m: Map<K, number>, labels: Record<K, string>) =>
    [...m.entries()].map(([key, tracks]) => ({ key, label: labels[key], tracks })).sort((a, b) => b.tracks - a.tracks);
  json(res, 200, {
    moods: toArr(moods, MOOD_LABELS),
    styles: toArr(styles, STYLE_LABELS),
    classifiedTracks: pool.reduce((n, t) => n + (classifyGenre(t.genre) ? 1 : 0), 0),
  });
}

/** POST /api/dj/queue — { seedPath?, mood?, style?, artist?, exclude?, limit? } → ordered PlayerTracks. */
async function djQueue(db: Database.Database, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await readBody(req);
  const pool = loadDjPool(db);
  if (pool.length === 0) return json(res, 200, { target: { label: 'Auto DJ' }, tracks: [] });

  const seedPath = b.seedPath ? String(b.seedPath) : '';
  let seed = seedPath ? pool.find((t) => t.path === seedPath) : undefined;
  // "Start a station from this artist": anchor on one of their tracks.
  if (!seed && b.artist) {
    const ak = String(b.artist).toLowerCase().trim();
    const matches = pool.filter((t) => (t.artist ?? '').toLowerCase().trim() === ak);
    if (matches.length) seed = matches[Math.floor(Math.random() * matches.length)];
  }
  const mood = isMood(typeof b.mood === 'string' ? b.mood : null) ? (b.mood as Mood) : undefined;
  const style = isStyleFamily(typeof b.style === 'string' ? b.style : null) ? (b.style as StyleFamily) : undefined;
  const exclude = Array.isArray(b.exclude) ? (b.exclude as unknown[]).map(String) : [];
  const limit = b.limit ? Math.max(1, Math.min(Number(b.limit), 100)) : 40;

  const set = autoDj(pool, {
    ...(seed ? { seed } : {}),
    ...(mood ? { mood } : {}),
    ...(style ? { style } : {}),
    exclude,
    limit,
  });
  const tracks = set.picks.map((p) => ({
    id: p.id,
    title: p.title,
    artistName: p.artist ?? 'Unknown Artist',
    path: p.path,
    durationMs: p.durationMs,
    ...(p.albumId ? { albumId: p.albumId } : {}),
    ...(p.albumTitle ? { albumTitle: p.albumTitle } : {}),
    reason: p.reason,
  }));
  json(res, 200, { target: set.target, tracks });
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
    if (jobs.latest('scan')?.state === 'running') return json(res, 409, { ok: false, error: 'scan_in_progress', job: scanStatusPayload() });
    jobs.enqueue('scan', { source });
    return json(res, 202, { ok: true, job: scanStatusPayload() });
  }
  if (path === '/api/scan/status') return json(res, 200, scanStatusPayload());

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
    if (jobs.latest('organize')?.state === 'running')
      return json(res, 409, { ok: false, error: 'organize_in_progress', job: organizeStatusPayload() });
    jobs.enqueue('organize', { source, dest, preset, writeTags });
    return json(res, 202, { ok: true, job: organizeStatusPayload() });
  }
  if (path === '/api/organize/status') return json(res, 200, organizeStatusPayload());
  if (path === '/api/organize/cancel' && method === 'POST') {
    const ok = jobs.cancelType('organize');
    return json(res, ok ? 200 : 409, { ok, job: organizeStatusPayload() });
  }

  // ---- sync profiles (subset → external drive) ----
  if (path === '/api/profiles' && method === 'GET') return json(res, 200, listProfiles(db));
  if (path === '/api/profiles' && method === 'POST') {
    const b = await readBody(req);
    const name = String(b.name ?? '').trim();
    if (!name) return json(res, 400, { ok: false, error: 'no_name' });
    const info = db
      .prepare('INSERT INTO profiles(name, target, preset, transcodeTo, createdAt) VALUES(?,?,?,?,?)')
      .run(
        name,
        String(b.target ?? '').trim(),
        String(b.preset ?? 'artist-year-album'),
        b.transcodeTo === 'mp3' ? 'mp3' : 'none',
        Date.now(),
      );
    return json(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
  }
  if (path === '/api/profiles/update' && method === 'POST') {
    const b = await readBody(req);
    const id = Number(b.id);
    if (!id) return json(res, 400, { ok: false, error: 'no_id' });
    const prof = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow | undefined;
    if (!prof) return json(res, 404, { ok: false, error: 'profile_not_found' });
    db.prepare('UPDATE profiles SET name=?, target=?, preset=?, transcodeTo=? WHERE id=?').run(
      b.name != null ? String(b.name).trim() || prof.name : prof.name,
      b.target != null ? String(b.target).trim() : prof.target,
      b.preset != null ? String(b.preset) : prof.preset,
      b.transcodeTo != null ? (b.transcodeTo === 'mp3' ? 'mp3' : 'none') : prof.transcodeTo,
      id,
    );
    return json(res, 200, { ok: true });
  }
  if (path === '/api/profiles/delete' && method === 'POST') {
    const b = await readBody(req);
    const id = Number(b.id);
    if (!id) return json(res, 400, { ok: false, error: 'no_id' });
    db.prepare('DELETE FROM profile_members WHERE profileId = ?').run(id);
    db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    return json(res, 200, { ok: true });
  }
  if (path === '/api/profile' && method === 'GET') {
    const d = profileDetail(db, Number(url.searchParams.get('id')));
    if (!d) return json(res, 404, { ok: false, error: 'profile_not_found' });
    return json(res, 200, d);
  }
  if (path === '/api/profile/add' && method === 'POST') {
    const b = await readBody(req);
    const id = Number(b.id);
    if (!id) return json(res, 400, { ok: false, error: 'no_id' });
    const now = Date.now();
    let added = 0;
    if (b.albumId) {
      added = db
        .prepare('INSERT OR IGNORE INTO profile_members(profileId, albumId, addedAt) VALUES(?,?,?)')
        .run(id, String(b.albumId), now).changes;
    } else if (b.artist) {
      added = db
        .prepare(
          `INSERT OR IGNORE INTO profile_members(profileId, albumId, addedAt)
           SELECT @id, a.id, @now FROM albums a
           WHERE a.artistName = @artist
              OR a.id IN (SELECT DISTINCT t.albumId FROM tracks t WHERE t.artistName = @artist AND t.albumId IS NOT NULL)`,
        )
        .run({ id, now, artist: String(b.artist) }).changes;
    } else {
      return json(res, 400, { ok: false, error: 'need_albumId_or_artist' });
    }
    return json(res, 200, { ok: true, added });
  }
  if (path === '/api/profile/remove' && method === 'POST') {
    const b = await readBody(req);
    const id = Number(b.id);
    if (!id || !b.albumId) return json(res, 400, { ok: false, error: 'need_id_and_albumId' });
    db.prepare('DELETE FROM profile_members WHERE profileId = ? AND albumId = ?').run(id, String(b.albumId));
    return json(res, 200, { ok: true });
  }
  if (path === '/api/profile/sync' && method === 'POST') {
    const b = await readBody(req);
    const id = Number(b.id);
    if (!id) return json(res, 400, { ok: false, error: 'no_id' });
    const pre = syncPreflight(db, id);
    if (pre.error) return json(res, pre.status ?? 409, { ok: false, error: pre.error, job: syncStatusPayload() });
    jobs.enqueue('sync', { profileId: id });
    return json(res, 202, { ok: true, job: syncStatusPayload() });
  }
  if (path === '/api/profile/sync/status') return json(res, 200, syncStatusPayload());
  if (path === '/api/profile/sync/cancel' && method === 'POST') {
    const ok = jobs.cancelType('sync');
    return json(res, ok ? 200 : 409, { ok });
  }

  // ---- listening playlists (manual + smart) ----
  if (path === '/api/playlists' && method === 'GET') {
    const rows = db.prepare('SELECT id, name, rules, createdAt FROM playlists ORDER BY createdAt ASC, id ASC').all() as Array<{
      id: number;
      name: string;
      rules: string | null;
      createdAt: number;
    }>;
    return json(
      res,
      200,
      rows.map((p) => {
        const smart = p.rules ? (JSON.parse(p.rules) as SmartRules) : null;
        const trackCount = smart
          ? smartTracks(db, smart).length
          : (db.prepare('SELECT COUNT(*) c FROM playlist_tracks pt JOIN tracks t ON t.path = pt.trackPath WHERE pt.playlistId = ?').get(p.id) as { c: number }).c;
        return { id: p.id, name: p.name, createdAt: p.createdAt, smart: !!smart, rules: smart, trackCount };
      }),
    );
  }
  if (path === '/api/playlists' && method === 'POST') {
    const b = await readBody(req);
    const name = String(b.name ?? '').trim();
    if (!name) return json(res, 400, { ok: false, error: 'no_name' });
    const rules = b.rules && typeof b.rules === 'object' ? JSON.stringify(b.rules) : null;
    const info = db.prepare('INSERT INTO playlists(name, rules, createdAt) VALUES(?,?,?)').run(name, rules, Date.now());
    return json(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
  }
  if (path === '/api/playlists/rules' && method === 'POST') {
    const b = await readBody(req);
    const id = Number(b.id);
    if (!id) return json(res, 400, { ok: false, error: 'no_id' });
    db.prepare('UPDATE playlists SET rules=? WHERE id=?').run(b.rules && typeof b.rules === 'object' ? JSON.stringify(b.rules) : null, id);
    return json(res, 200, { ok: true });
  }
  if (path === '/api/playlists/rename' && method === 'POST') {
    const b = await readBody(req);
    const id = Number(b.id);
    const name = String(b.name ?? '').trim();
    if (!id || !name) return json(res, 400, { ok: false, error: 'need_id_and_name' });
    db.prepare('UPDATE playlists SET name=? WHERE id=?').run(name, id);
    return json(res, 200, { ok: true });
  }
  if (path === '/api/playlists/delete' && method === 'POST') {
    const b = await readBody(req);
    const id = Number(b.id);
    if (!id) return json(res, 400, { ok: false, error: 'no_id' });
    db.prepare('DELETE FROM playlist_tracks WHERE playlistId=?').run(id);
    db.prepare('DELETE FROM playlists WHERE id=?').run(id);
    return json(res, 200, { ok: true });
  }
  if (path === '/api/playlist' && method === 'GET') {
    const id = Number(url.searchParams.get('id'));
    const p = db.prepare('SELECT id, name, rules, createdAt FROM playlists WHERE id=?').get(id) as
      | { id: number; name: string; rules: string | null; createdAt: number }
      | undefined;
    if (!p) return json(res, 404, { ok: false, error: 'playlist_not_found' });
    const smart = p.rules ? (JSON.parse(p.rules) as SmartRules) : null;
    const tracks = smart
      ? smartTracks(db, smart)
      : (
          db
            .prepare(
              `SELECT t.id, t.title, t.artistName, t.album, t.albumId, t.path, t.durationMs, t.bitrateKbps, t.lossless, t.sizeBytes, pt.position
               FROM playlist_tracks pt JOIN tracks t ON t.path = pt.trackPath
               WHERE pt.playlistId = ? ORDER BY pt.position ASC`,
            )
            .all(id) as Array<{ lossless: number; [k: string]: unknown }>
        ).map((t) => ({ ...t, lossless: t.lossless === 1 }));
    return json(res, 200, { id: p.id, name: p.name, createdAt: p.createdAt, smart: !!smart, rules: smart, tracks });
  }
  if (path === '/api/playlist/add' && method === 'POST') {
    const b = await readBody(req);
    const id = Number(b.id);
    if (!id) return json(res, 400, { ok: false, error: 'no_id' });
    // collect paths: explicit trackPath(s), or every track of an album
    let paths: string[] = [];
    if (b.albumId) {
      paths = (db.prepare('SELECT path FROM tracks WHERE albumId=? ORDER BY COALESCE(discNo,1), COALESCE(trackNo,9999)').all(String(b.albumId)) as Array<{ path: string }>).map((r) => r.path);
    } else if (Array.isArray(b.trackPaths)) {
      paths = (b.trackPaths as unknown[]).map(String);
    } else if (b.trackPath) {
      paths = [String(b.trackPath)];
    }
    if (paths.length === 0) return json(res, 400, { ok: false, error: 'no_tracks' });
    let pos = (db.prepare('SELECT COALESCE(MAX(position),-1) m FROM playlist_tracks WHERE playlistId=?').get(id) as { m: number }).m;
    const ins = db.prepare('INSERT OR IGNORE INTO playlist_tracks(playlistId, trackPath, position) VALUES(?,?,?)');
    let added = 0;
    const tx = db.transaction(() => {
      for (const p of paths) added += ins.run(id, p, ++pos).changes;
    });
    tx();
    return json(res, 200, { ok: true, added });
  }
  if (path === '/api/playlist/remove' && method === 'POST') {
    const b = await readBody(req);
    const id = Number(b.id);
    if (!id || !b.trackPath) return json(res, 400, { ok: false, error: 'need_id_and_trackPath' });
    db.prepare('DELETE FROM playlist_tracks WHERE playlistId=? AND trackPath=?').run(id, String(b.trackPath));
    return json(res, 200, { ok: true });
  }
  if (path === '/api/playlist/reorder' && method === 'POST') {
    const b = await readBody(req);
    const id = Number(b.id);
    const order = Array.isArray(b.trackPaths) ? (b.trackPaths as unknown[]).map(String) : [];
    if (!id || order.length === 0) return json(res, 400, { ok: false, error: 'need_id_and_order' });
    const upd = db.prepare('UPDATE playlist_tracks SET position=? WHERE playlistId=? AND trackPath=?');
    const tx = db.transaction(() => order.forEach((p, i) => upd.run(i, id, p)));
    tx();
    return json(res, 200, { ok: true });
  }

  // ---- online refresh (metadata + cover) ----
  if (path === '/api/album/refresh' && method === 'POST') {
    const b = await readBody(req);
    const albumId = String(b.albumId ?? '');
    if (!albumId) return json(res, 400, { ok: false, error: 'no_albumId' });
    const r = await refreshAlbum(db, albumId, !!b.force);
    if (!r) return json(res, 404, { ok: false, error: 'album_not_found' });
    return json(res, 200, { ok: true, ...r });
  }
  if (path === '/api/album/refresh/cover' && method === 'GET') {
    const albumId = url.searchParams.get('albumId') ?? '';
    const p = url.searchParams.get('pending') === '1' ? pendingCoverPath(albumId) : finalCoverPath(albumId);
    if (!albumId || !existsSync(p)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    pipeSafe(createReadStream(p), res);
    return;
  }
  if (path === '/api/album/refresh/apply' && method === 'POST') {
    const b = await readBody(req);
    const albumId = String(b.albumId ?? '');
    if (!albumId) return json(res, 400, { ok: false, error: 'no_albumId' });
    await applyRefresh(db, albumId, {
      ...(b.title != null ? { title: String(b.title) } : {}),
      ...(b.year != null ? { year: Number(b.year) } : {}),
      cover: !!b.cover,
      ...(b.mbid != null ? { mbid: String(b.mbid) } : {}),
    });
    return json(res, 200, { ok: true });
  }
  if (path === '/api/album/refresh/cancel' && method === 'POST') {
    const b = await readBody(req);
    const p = pendingCoverPath(String(b.albumId ?? ''));
    if (existsSync(p)) await unlink(p).catch(() => {});
    return json(res, 200, { ok: true });
  }
  if (path === '/api/album/completeness' && method === 'POST') {
    const b = await readBody(req);
    const albumId = String(b.albumId ?? '');
    if (!albumId) return json(res, 400, { ok: false, error: 'no_albumId' });
    const r = await albumCompleteness(db, albumId);
    if (!r) return json(res, 404, { ok: false, error: 'album_not_found' });
    return json(res, 200, { ok: true, ...r });
  }

  // ---- batch refresh (library sweep → review queue), backed by the JobService ----
  if (path === '/api/refresh/start' && method === 'POST') {
    const b = await readBody(req);
    jobs.enqueue('refresh', {
      onlyMissing: b.onlyMissing !== false,
      force: !!b.force,
      ...(b.limit ? { limit: Number(b.limit) } : {}),
    });
    return json(res, 202, { ok: true, job: refreshStatusPayload() });
  }
  if (path === '/api/refresh/status') return json(res, 200, refreshStatusPayload());
  if (path === '/api/refresh/candidates') {
    const noOverride = `id NOT IN (SELECT albumId FROM album_overrides)`;
    const missingWhere = `${noOverride} AND (coverPath IS NULL OR coverPath = '')`;
    const missing = (db.prepare(`SELECT COUNT(*) c FROM albums WHERE ${missingWhere}`).get() as { c: number }).c;
    const attempted = (db.prepare(`SELECT COUNT(*) c FROM albums WHERE ${missingWhere} AND id IN (SELECT albumId FROM album_enrich)`).get() as { c: number }).c;
    const total = (db.prepare('SELECT COUNT(*) c FROM albums').get() as { c: number }).c;
    return json(res, 200, { missing, attempted, total });
  }
  if (path === '/api/refresh/cancel' && method === 'POST') {
    jobs.cancelType('refresh');
    return json(res, 200, { ok: true });
  }
  if (path === '/api/refresh/apply-batch' && method === 'POST') {
    const b = await readBody(req);
    const items = Array.isArray(b.items) ? (b.items as Array<Record<string, unknown>>) : [];
    const latest = jobs.latest('refresh');
    const allProposals = latest ? (jobs.items(latest.id) as RefreshProposal[]) : [];
    const applied = await applyBatch(
      db,
      items.map((it) => ({
        albumId: String(it.albumId),
        ...(it.title != null ? { title: String(it.title) } : {}),
        ...(it.year != null ? { year: Number(it.year) } : {}),
        cover: !!it.cover,
        ...(it.mbid != null ? { mbid: String(it.mbid) } : {}),
      })),
      allProposals,
    );
    return json(res, 200, { ok: true, applied });
  }
  if (path === '/api/jobs/active') return json(res, 200, activeJobs());

  // ---- read endpoints ----
  if (path === '/api/overview') return overview(db, res);
  if (path === '/api/artists') return artists(db, res);
  if (path === '/api/albums') return allAlbums(db, res);
  if (path === '/api/search') return search(db, res, url.searchParams.get('q') ?? '');
  if (path === '/api/duplicates') return duplicates(db, res);
  if (path === '/api/reconstruct/metadata') return reconstructMetadata(db, res);
  if (path === '/api/cover') return cover(db, res, url.searchParams);
  if (path === '/api/audio') return serveAudio(db, req, res, url.searchParams);
  if (path === '/api/lyrics') return serveLyrics(db, res, url.searchParams);
  if (path === '/api/loudness') return serveLoudness(db, res, url.searchParams);
  if (path === '/api/dj/moods') return djMoods(db, res);
  if (path === '/api/dj/queue' && method === 'POST') return djQueue(db, req, res);

  const artistMatch = /^\/api\/artist\/(.+)$/.exec(path);
  if (artistMatch) return artist(db, res, decodeURIComponent(artistMatch[1]!));

  const albumMatch = /^\/api\/album\/(.+)$/.exec(path);
  if (albumMatch) return album(db, res, decodeURIComponent(albumMatch[1]!));

  json(res, 404, { ok: false, error: 'not_found', path });
}

export function start(): void {
  const db = openDb();
  jobs = new JobService(db); // durable job runtime + boot recovery (orphaned 'running' → 'paused')
  jobs.register('scan', (ctx) => scanHandler(ctx));
  jobs.register('sync', (ctx) => syncHandler(db, ctx));
  jobs.register('organize', (ctx) => organizeHandler(ctx));
  jobs.register('refresh', (ctx) => refreshHandler(db, ctx));
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
