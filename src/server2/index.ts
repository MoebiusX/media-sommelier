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
import { stat, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  readCover,
  walkToArray,
  reconstruct,
  planOrganize,
  executePlan,
  sanitizeSegment,
  MusicBrainzClient,
  selectBestRelease,
  artistCreditName,
  ORGANIZE_PRESETS,
  type OrganizePlan,
  type OrganizeAction,
  type TrackTags,
  type AlbumCandidate,
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
  // Sync profiles: a named subset of the library mirrored to an external drive. Independent of the
  // derived tracks/albums tables (ingest's clearAll never touches these). albumId is a plain TEXT join
  // (NOT a foreign key) so re-ingest can freely DELETE+repopulate albums without a constraint error;
  // album ids are deterministic slugs, so a saved profile re-joins after a re-scan.
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      target     TEXT    NOT NULL DEFAULT '',
      preset     TEXT    NOT NULL DEFAULT 'artist-year-album',
      createdAt  INTEGER NOT NULL DEFAULT 0,
      lastSyncAt INTEGER
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
  `);
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

let scanJob: Job = { state: 'idle', phase: '', done: 0, total: 0 };
let organizeJob: Job = { state: 'idle', phase: '', done: 0, total: 0 };
let organizeChild: ChildProcess | null = null;
let syncJob: Job = { state: 'idle', phase: '', done: 0, total: 0 };
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
  createdAt: number;
  lastSyncAt: number | null;
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
      `SELECT p.id, p.name, p.target, p.preset, p.createdAt, p.lastSyncAt,
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

/** Start an additive sync of a profile to its target drive. Single in-flight job, polled by the UI. */
function startSync(db: Database.Database, profileId: number): { ok: boolean; error?: string; job: Job } {
  if (syncJob.state === 'running') return { ok: false, error: 'sync_in_progress', job: syncJob };
  const prof = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as ProfileRow | undefined;
  if (!prof) return { ok: false, error: 'profile_not_found', job: syncJob };
  if (!prof.target.trim()) return { ok: false, error: 'no_target', job: syncJob };
  const rows = profileTracks(db, profileId);
  if (rows.length === 0) return { ok: false, error: 'empty_profile', job: syncJob };
  const plan = buildSyncPlan(rows, prof.target, prof.preset);
  const libRoot = meta<{ root?: string }>(db, 'overview')?.root;
  syncJob = { state: 'running', profileId, dest: prof.target, phase: 'copying', done: 0, total: plan.actions.length, startedAt: Date.now() };
  void (async () => {
    try {
      const report = await executePlan(plan, {
        ...(libRoot ? { sourceRoot: libRoot } : {}),
        onProgress: (done, total) => {
          syncJob.done = done;
          syncJob.total = total;
        },
      });
      db.prepare('UPDATE profiles SET lastSyncAt = ? WHERE id = ?').run(Date.now(), profileId);
      syncJob = {
        ...syncJob,
        state: 'done',
        phase: 'done',
        result: { copied: report.copied, skipped: report.skipped, failed: report.failed, bytes: report.bytesCopied, dest: prof.target },
        finishedAt: Date.now(),
      };
    } catch (e) {
      syncJob = { ...syncJob, state: 'error', error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() };
    }
  })();
  return { ok: true, job: syncJob };
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

/** Run a lookup for one album and stage the fetched cover under its pending path. */
async function refreshAlbum(
  db: Database.Database,
  albumId: string,
): Promise<{ matched: boolean; before: { title: string; year: number | null }; match?: RefreshMatch; coverFetched: boolean } | null> {
  const al = db.prepare('SELECT id, title, artistName, year, trackCount FROM albums WHERE id = ?').get(albumId) as
    | { title: string; artistName: string; year: number | null; trackCount: number }
    | undefined;
  if (!al) return null;
  const before = { title: al.title, year: al.year };
  const match = await lookupAlbum({ artistName: al.artistName, title: al.title, trackCount: al.trackCount });
  if (!match) return { matched: false, before, coverFetched: false };
  let coverFetched = false;
  const cover = await fetchFrontCover(match);
  if (cover) {
    await mkdir(COVER_DIR, { recursive: true });
    await writeFile(pendingCoverPath(albumId), cover);
    coverFetched = true;
  }
  return { matched: true, before, match, coverFetched };
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

/* ---- batch refresh: sweep the library, propose covers/metadata, the user reviews then applies ---- */
interface RefreshProposal {
  albumId: string;
  artistName: string;
  title: string;
  year: number | null;
  match: { album: string; year?: number; score: number; mbid: string };
  coverFetched: boolean;
}
interface RefreshBatchJob {
  state: 'idle' | 'running' | 'done' | 'error';
  phase: string;
  done: number;
  total: number;
  proposals: RefreshProposal[];
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}
let refreshJob: RefreshBatchJob = { state: 'idle', phase: '', done: 0, total: 0, proposals: [] };
let refreshCancel = false;

/** Start a background sweep proposing online matches. `onlyMissing` targets albums without folder art. */
function startRefreshBatch(db: Database.Database, opts: { onlyMissing: boolean; limit?: number }): { ok: boolean; error?: string } {
  if (refreshJob.state === 'running') return { ok: false, error: 'refresh_in_progress' };
  const noOverride = `a.id NOT IN (SELECT albumId FROM album_overrides)`;
  const where = opts.onlyMissing ? `WHERE ${noOverride} AND (a.coverPath IS NULL OR a.coverPath = '')` : `WHERE ${noOverride}`;
  let rows = db
    .prepare(`SELECT a.id, a.artistName, a.title, a.year, a.trackCount FROM albums a ${where} ORDER BY a.trackCount DESC`)
    .all() as Array<{ id: string; artistName: string; title: string; year: number | null; trackCount: number }>;
  if (opts.limit && opts.limit > 0) rows = rows.slice(0, opts.limit);
  refreshCancel = false;
  refreshJob = { state: 'running', phase: 'looking up releases', done: 0, total: rows.length, proposals: [], startedAt: Date.now() };
  void (async () => {
    try {
      for (const a of rows) {
        if (refreshCancel) break;
        const match = await lookupAlbum({ artistName: a.artistName, title: a.title, trackCount: a.trackCount });
        if (match) {
          let coverFetched = false;
          const cover = await fetchFrontCover(match);
          if (cover) {
            await mkdir(COVER_DIR, { recursive: true });
            await writeFile(pendingCoverPath(a.id), cover);
            coverFetched = true;
          }
          // Only propose if there's something to gain: a cover or a year we don't have.
          if (coverFetched || (match.year != null && match.year !== a.year)) {
            refreshJob.proposals.push({
              albumId: a.id,
              artistName: a.artistName,
              title: a.title,
              year: a.year,
              match: { album: match.album, ...(match.year != null ? { year: match.year } : {}), score: match.score, mbid: match.mbid },
              coverFetched,
            });
          }
        }
        refreshJob.done++;
      }
      refreshJob = { ...refreshJob, state: 'done', phase: refreshCancel ? 'cancelled' : 'done', finishedAt: Date.now() };
    } catch (e) {
      refreshJob = { ...refreshJob, state: 'error', error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() };
    }
  })();
  return { ok: true };
}

/** Apply the user-selected subset of batch proposals; discard the staged covers of the rest. */
async function applyBatch(
  db: Database.Database,
  items: Array<{ albumId: string; title?: string; year?: number; cover?: boolean; mbid?: string }>,
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
  for (const p of refreshJob.proposals) {
    if (!keep.has(p.albumId)) {
      const pp = pendingCoverPath(p.albumId);
      if (existsSync(pp)) await unlink(pp).catch(() => {});
    }
  }
  return items.length;
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

  // ---- sync profiles (subset → external drive) ----
  if (path === '/api/profiles' && method === 'GET') return json(res, 200, listProfiles(db));
  if (path === '/api/profiles' && method === 'POST') {
    const b = await readBody(req);
    const name = String(b.name ?? '').trim();
    if (!name) return json(res, 400, { ok: false, error: 'no_name' });
    const info = db
      .prepare('INSERT INTO profiles(name, target, preset, createdAt) VALUES(?,?,?,?)')
      .run(name, String(b.target ?? '').trim(), String(b.preset ?? 'artist-year-album'), Date.now());
    return json(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
  }
  if (path === '/api/profiles/update' && method === 'POST') {
    const b = await readBody(req);
    const id = Number(b.id);
    if (!id) return json(res, 400, { ok: false, error: 'no_id' });
    const prof = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow | undefined;
    if (!prof) return json(res, 404, { ok: false, error: 'profile_not_found' });
    db.prepare('UPDATE profiles SET name=?, target=?, preset=? WHERE id=?').run(
      b.name != null ? String(b.name).trim() || prof.name : prof.name,
      b.target != null ? String(b.target).trim() : prof.target,
      b.preset != null ? String(b.preset) : prof.preset,
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
    const r = startSync(db, id);
    return json(res, r.ok ? 202 : 409, r);
  }
  if (path === '/api/profile/sync/status') return json(res, 200, syncJob);

  // ---- online refresh (metadata + cover) ----
  if (path === '/api/album/refresh' && method === 'POST') {
    const b = await readBody(req);
    const albumId = String(b.albumId ?? '');
    if (!albumId) return json(res, 400, { ok: false, error: 'no_albumId' });
    const r = await refreshAlbum(db, albumId);
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

  // ---- batch refresh (library sweep → review queue) ----
  if (path === '/api/refresh/start' && method === 'POST') {
    const b = await readBody(req);
    const r = startRefreshBatch(db, {
      onlyMissing: b.onlyMissing !== false,
      ...(b.limit ? { limit: Number(b.limit) } : {}),
    });
    return json(res, r.ok ? 202 : 409, { ...r, job: refreshJob });
  }
  if (path === '/api/refresh/status') return json(res, 200, refreshJob);
  if (path === '/api/refresh/candidates') {
    const noOverride = `id NOT IN (SELECT albumId FROM album_overrides)`;
    const missing = (db.prepare(`SELECT COUNT(*) c FROM albums WHERE ${noOverride} AND (coverPath IS NULL OR coverPath = '')`).get() as { c: number }).c;
    const total = (db.prepare('SELECT COUNT(*) c FROM albums').get() as { c: number }).c;
    return json(res, 200, { missing, total });
  }
  if (path === '/api/refresh/cancel' && method === 'POST') {
    refreshCancel = true;
    return json(res, 200, { ok: true });
  }
  if (path === '/api/refresh/apply-batch' && method === 'POST') {
    const b = await readBody(req);
    const items = Array.isArray(b.items) ? (b.items as Array<Record<string, unknown>>) : [];
    const applied = await applyBatch(
      db,
      items.map((it) => ({
        albumId: String(it.albumId),
        ...(it.title != null ? { title: String(it.title) } : {}),
        ...(it.year != null ? { year: Number(it.year) } : {}),
        cover: !!it.cover,
        ...(it.mbid != null ? { mbid: String(it.mbid) } : {}),
      })),
    );
    return json(res, 200, { ok: true, applied });
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
