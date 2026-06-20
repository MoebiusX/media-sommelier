#!/usr/bin/env node
/**
 * Local web UI server — a thin HTTP layer over the engine. Because it runs on the user's own machine,
 * it can pop a NATIVE folder picker and actually execute the organize copy. This is the UI renderer
 * layer; an Electron shell would host the same page + engine.
 *
 *   npm run ui    →    http://localhost:4178
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  parseDirListing,
  reconstruct,
  computeInsights,
  planOrganize,
  executePlan,
  walkToArray,
  readCover,
  scanLibraryCached,
  computeLibraryStats,
  scanPhotos,
  scanVideos,
  MusicBrainzClient,
  AcoustIdClient,
  enrichCandidate,
  ORGANIZE_PRESETS,
  type MediaFileRecord,
  type ReconstructionReport,
  type AlbumEnrichment,
  type Track,
  type Video,
} from '../engine/index.js';

const IMAGE_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', tiff: 'image/tiff' };

const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', wma: 'audio/x-ms-wma', aiff: 'audio/aiff',
};

const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', m4v: 'video/x-m4v', mpg: 'video/mpeg', mpeg: 'video/mpeg',
};

/** Stream a file with HTTP Range support so players can seek. Used for both audio and video. */
async function serveFile(req: IncomingMessage, res: ServerResponse, path: string, mimeMap: Record<string, string>): Promise<void> {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  const type = mimeMap[ext];
  if (!type) { res.writeHead(415); res.end(); return; }
  let size: number;
  try { size = (await stat(path)).size; } catch { res.writeHead(404); res.end(); return; }
  const range = req.headers.range;
  const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : size - 1;
    res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    createReadStream(path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
    createReadStream(path).pipe(res);
  }
}

/** Stream an audio file with HTTP Range support so the player can seek. */
function serveAudio(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  return serveFile(req, res, path, AUDIO_MIME);
}

/** Lean track record for the wire (drop fields the grid doesn't need). */
function leanTrack(t: Track) {
  return {
    path: t.path, artist: t.albumArtist || t.artist || '', album: t.album || '', title: t.title,
    genre: t.genre || '', year: t.year ?? null, trackNo: t.trackNo ?? null, discNo: t.discNo ?? null,
    durationMs: t.durationMs ?? null, bitrateKbps: t.bitrateKbps ?? null, lossless: !!t.lossless, sizeBytes: t.sizeBytes,
  };
}

/** Lean video record for the wire (drop fields the grid doesn't need). */
function leanVideo(v: Video) {
  return {
    path: v.path, title: v.title, durationMs: v.durationMs ?? null,
    width: v.width ?? null, height: v.height ?? null, videoCodec: v.videoCodec ?? '',
    bitrateKbps: v.bitrateKbps ?? null, sizeBytes: v.sizeBytes,
  };
}

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const POSTER_DIR = 'data/posters';

/** Resolve the ffmpeg binary: FFMPEG_PATH env → bundled ffmpeg-static → bare name on PATH. */
function ffmpegPath(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  try {
    const require = createRequire(import.meta.url);
    const p = require('ffmpeg-static') as string | null;
    if (p && existsSync(p)) return p;
  } catch {
    // fall through to PATH lookup
  }
  return exe;
}

/**
 * Best-effort poster: grab one frame ~10% into the video to a cached jpeg under data/posters/.
 * Returns the cache path, or null if ffmpeg is unavailable or extraction fails. Never touches the source.
 */
async function posterFor(srcPath: string): Promise<string | null> {
  const hash = createHash('sha1').update(srcPath).digest('hex');
  const out = join(POSTER_DIR, `${hash}.jpg`);
  if (existsSync(out)) return out;
  let durationSec = 0;
  try {
    const { readVideo } = await import('../engine/index.js');
    const meta = await readVideo(srcPath);
    if (meta.durationMs) durationSec = meta.durationMs / 1000;
  } catch {
    // ignore; fall back to a fixed seek
  }
  const seek = durationSec > 0 ? Math.max(1, durationSec * 0.1) : 10;
  try {
    await mkdir(POSTER_DIR, { recursive: true });
    await execFileAsync(
      ffmpegPath(),
      ['-y', '-ss', String(seek), '-i', srcPath, '-frames:v', '1', '-q:v', '4', '-vf', 'scale=480:-1', out],
      { timeout: 60_000 },
    );
    return existsSync(out) ? out : null;
  } catch {
    return null;
  }
}
const SAMPLE = 'test/fixtures/sample/sample-collection.dir.txt';
const PORT = Number(process.env.PORT ?? 4178);

async function inventoryFor(source: string | null): Promise<MediaFileRecord[]> {
  if (!source || source === 'sample') return parseDirListing(await readFile(SAMPLE, 'utf8'));
  return walkToArray(source, { include: ['music'] });
}

/** Build enrichment overrides (MusicBrainz + AcoustID fallback on real files). Cached on disk. */
async function enrichmentFor(report: ReconstructionReport, source: string | null): Promise<Map<string, AlbumEnrichment>> {
  const mb = new MusicBrainzClient({});
  const acoustid = new AcoustIdClient({});
  const fp = acoustid.hasKey() && !!source && source !== 'sample';
  const map = new Map<string, AlbumEnrichment>();
  for (const c of report.candidates) {
    const e = await enrichCandidate(c, { mb, acoustid, fingerprintFallback: fp, fetchTracklist: true });
    if (e.status === 'matched' && e.match) {
      const tl = e.match.tracklist ?? [];
      const trackTitles = new Map<string, string>();
      for (const t of tl) trackTitles.set(`${t.disc}:${t.position}`, t.title);
      map.set(c.id, {
        artist: e.match.artist,
        album: e.match.album,
        ...(e.match.year != null ? { year: e.match.year } : {}),
        ...(e.match.mbid ? { mbReleaseId: e.match.mbid } : {}),
        ...(e.match.releaseGroupMbid ? { mbReleaseGroupId: e.match.releaseGroupMbid } : {}),
        ...(trackTitles.size ? { trackTitles } : {}),
        ...(tl.length ? { tracklist: tl } : {}),
      });
    }
  }
  return map;
}

/** Native OS folder picker (Windows). Returns the chosen absolute path, or '' if cancelled. */
async function pickFolder(): Promise<string> {
  if (process.platform !== 'win32') return '';
  const ps =
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null; " +
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
    "$d.Description = 'Choose your music folder'; " +
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }";
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-STA', '-Command', ps], { timeout: 120_000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

function json(res: ServerResponse, obj: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const templateFor = (key?: string | null): string | undefined =>
  key && ORGANIZE_PRESETS[key] ? ORGANIZE_PRESETS[key]!.template : key && key.includes('{') ? key : undefined;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(join(here, 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url.pathname === '/api/presets') return json(res, ORGANIZE_PRESETS);
    if (url.pathname === '/api/pick-folder') return json(res, { path: await pickFolder() });
    if (url.pathname === '/api/audio') {
      const p = url.searchParams.get('path');
      if (!p) { res.writeHead(400); res.end(); return; }
      return serveAudio(req, res, p);
    }
    if (url.pathname === '/api/video') {
      const p = url.searchParams.get('path');
      if (!p) { res.writeHead(400); res.end(); return; }
      return serveFile(req, res, p, VIDEO_MIME);
    }
    if (url.pathname === '/api/videos') {
      const folder = url.searchParams.get('source');
      if (!folder || folder === 'sample') return json(res, { needsFolder: true });
      const r = await scanVideos(folder);
      return json(res, { root: folder, stats: r.stats, videos: r.videos.map(leanVideo) });
    }
    if (url.pathname === '/api/poster') {
      const p = url.searchParams.get('path');
      if (!p) { res.writeHead(400); res.end(); return; }
      const poster = await posterFor(p);
      if (!poster) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' });
      createReadStream(poster).pipe(res);
      return;
    }
    if (url.pathname === '/api/cover') {
      const p = url.searchParams.get('path');
      if (!p) { res.writeHead(400); res.end(); return; }
      const c = await readCover(p);
      if (!c) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': c.mime, 'cache-control': 'max-age=86400' });
      res.end(c.data);
      return;
    }
    if (url.pathname === '/api/image') {
      const p = url.searchParams.get('path');
      const ext = (p?.split('.').pop() ?? '').toLowerCase();
      if (!p || !IMAGE_MIME[ext]) { res.writeHead(p ? 415 : 400); res.end(); return; }
      try {
        await stat(p);
      } catch { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': IMAGE_MIME[ext], 'cache-control': 'max-age=86400' });
      createReadStream(p).pipe(res);
      return;
    }
    if (url.pathname === '/api/photos') {
      const folder = url.searchParams.get('source');
      if (!folder || folder === 'sample') return json(res, { needsFolder: true });
      const r = await scanPhotos(folder);
      return json(res, { stats: r.stats, photos: r.photos.map((p) => ({ path: p.path, name: p.name, takenAt: p.takenAt ?? null, camera: p.camera ?? '', width: p.width ?? null, height: p.height ?? null, gps: p.gpsLat != null, gpsLat: p.gpsLat ?? null, gpsLon: p.gpsLon ?? null, sizeBytes: p.sizeBytes })) });
    }
    if (url.pathname === '/api/library') {
      const folder = url.searchParams.get('source');
      if (!folder || folder === 'sample') return json(res, { needsFolder: true });
      const r = await scanLibraryCached(folder, { cacheDir: 'data/catalogs' });
      return json(res, { root: folder, stats: computeLibraryStats(r.tracks), tracks: r.tracks.map(leanTrack), cache: { cached: r.cached, scanned: r.scanned, removed: r.removed } });
    }

    const source = url.searchParams.get('source');
    if (url.pathname === '/api/reconstruct') return json(res, reconstruct(await inventoryFor(source)));
    if (url.pathname === '/api/insights') {
      const inv = await inventoryFor(source);
      return json(res, computeInsights(inv, reconstruct(inv)));
    }
    if (url.pathname === '/api/plan') {
      const inv = await inventoryFor(source);
      const report = reconstruct(inv);
      const enrichment = url.searchParams.get('enrich') === '1' ? await enrichmentFor(report, source) : undefined;
      const plan = planOrganize(report.candidates, {
        destRoot: url.searchParams.get('dest') || 'D:/Organized',
        ...(templateFor(url.searchParams.get('template')) ? { template: templateFor(url.searchParams.get('template')) } : {}),
        ...(enrichment ? { enrichment } : {}),
      });
      return json(res, { actions: plan.actions.length, collisions: plan.collisions.length, skipped: plan.skipped.length, sample: plan.actions.slice(0, 80).map((a) => a.destRelPath) });
    }
    if (req.method === 'POST' && url.pathname === '/api/organize') {
      const b = await readBody(req);
      const src = (b.source as string) || 'sample';
      const inv = await inventoryFor(src);
      const report = reconstruct(inv);
      const enrichment = b.enrich ? await enrichmentFor(report, src) : undefined;
      const plan = planOrganize(report.candidates, {
        destRoot: (b.dest as string) || 'D:/Organized',
        ...(templateFor(b.template as string) ? { template: templateFor(b.template as string) } : {}),
        ...(enrichment ? { enrichment } : {}),
      });
      if (!b.execute) return json(res, { dryRun: true, actions: plan.actions.length, collisions: plan.collisions.length });
      const result = await executePlan(plan, {
        writeTags: !!b.writeTags,
        ...(src !== 'sample' ? { sourceRoot: src } : {}),
      });
      return json(res, { copied: result.copied, skipped: result.skipped, failed: result.failed, tagged: result.tagged, bytes: result.bytesCopied });
    }
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

server.listen(PORT, () => console.log(`🍷 Media Sommelier UI → http://localhost:${PORT}`));
