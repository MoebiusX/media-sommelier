#!/usr/bin/env node
/**
 * Local web UI server — a thin HTTP layer over the engine. Because it runs on the user's own machine,
 * it can pop a NATIVE folder picker and actually execute the organize copy. This is the UI renderer
 * layer; an Electron shell would host the same page + engine.
 *
 *   npm run ui    →    http://localhost:4178
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseDirListing,
  reconstruct,
  computeInsights,
  planOrganize,
  executePlan,
  walkToArray,
  MusicBrainzClient,
  AcoustIdClient,
  enrichCandidate,
  ORGANIZE_PRESETS,
  type MediaFileRecord,
  type ReconstructionReport,
  type AlbumEnrichment,
} from '../engine/index.js';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
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
