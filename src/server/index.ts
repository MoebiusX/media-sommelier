#!/usr/bin/env node
/**
 * Local web UI server — a thin HTTP layer over the engine so the reconstruction/insights/organize
 * results are browsable in a browser. Zero web framework (Node http). This is the UI *renderer* layer;
 * an Electron shell would host this same page + the engine in a utilityProcess.
 *
 *   npm run ui    →    http://localhost:4178
 */
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDirListing, reconstruct, computeInsights, planOrganize, walkToArray, type MediaFileRecord } from '../engine/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = 'test/fixtures/sample/sample-collection.dir.txt';
const PORT = Number(process.env.PORT ?? 4178);

async function inventoryFor(source: string | null): Promise<MediaFileRecord[]> {
  if (!source || source === 'sample') return parseDirListing(await readFile(SAMPLE, 'utf8'));
  return walkToArray(source, { include: ['music'] });
}

function json(res: ServerResponse, obj: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(join(here, 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    const source = url.searchParams.get('source');
    if (url.pathname === '/api/reconstruct') return json(res, reconstruct(await inventoryFor(source)));
    if (url.pathname === '/api/insights') {
      const inv = await inventoryFor(source);
      return json(res, computeInsights(inv, reconstruct(inv)));
    }
    if (url.pathname === '/api/plan') {
      const inv = await inventoryFor(source);
      const destRoot = url.searchParams.get('dest') || 'D:/Organized';
      return json(res, planOrganize(reconstruct(inv).candidates, { destRoot }));
    }
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

server.listen(PORT, () => console.log(`🍷 Media Sommelier UI → http://localhost:${PORT}`));
