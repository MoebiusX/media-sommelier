import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { MusicBrainzClient, AcoustIdClient } from '../src/engine/index.js';

/** Build a minimal Response-like object for an injected fetch. */
function res(data: unknown, { ok = true, status = 200 } = {}): Response {
  return { ok, status, json: async () => data } as unknown as Response;
}

const dirs: string[] = [];
async function cacheDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'somm-cache-'));
  dirs.push(d);
  return d;
}

describe('MusicBrainzClient', () => {
  it('caches a search so a repeat hits disk, not the network', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return res({ releases: [{ id: 'r1', title: 'Echoes', 'track-count': 26 }] });
    }) as unknown as typeof fetch;
    const mb = new MusicBrainzClient({ cacheDir: await cacheDir(), fetchImpl });
    const a = await mb.searchReleases('Pink Floyd', 'Echoes');
    const b = await mb.searchReleases('Pink Floyd', 'Echoes');
    expect(a).toEqual(b);
    expect(a[0]!.id).toBe('r1');
    expect(calls).toBe(1);
    expect(mb.stats.network).toBe(1);
    expect(mb.stats.cacheHits).toBe(1);
  });

  it('offline mode never hits the network and returns []', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return res({ releases: [] });
    }) as unknown as typeof fetch;
    const mb = new MusicBrainzClient({ cacheDir: await cacheDir(), offline: true, fetchImpl });
    expect(await mb.searchReleases('X', 'Y')).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('AcoustIdClient', () => {
  const fp = { duration: 436, fingerprint: 'AQADtGGSKF8' };

  it('parses a successful lookup and caches it', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return res({ status: 'ok', results: [{ id: 'aid1', score: 0.95, recordings: [{ id: 'rec1', title: 'Hotel California', artists: [{ name: 'Eagles' }] }] }] });
    }) as unknown as typeof fetch;
    const c = new AcoustIdClient({ apiKey: 'APPKEY', cacheDir: await cacheDir(), fetchImpl });
    const r1 = await c.lookup(fp);
    const r2 = await c.lookup(fp);
    expect(r1.best?.recordingTitle).toBe('Hotel California');
    expect(r1.best?.artist).toBe('Eagles');
    expect(calls).toBe(1); // second served from cache
    expect(c.stats.cacheHits).toBe(1);
  });

  it('does NOT cache error responses (so a fixed key works on retry)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return res({ status: 'error', error: { message: 'invalid API key' } });
    }) as unknown as typeof fetch;
    const c = new AcoustIdClient({ apiKey: 'BADKEY', cacheDir: await cacheDir(), fetchImpl });
    const r1 = await c.lookup(fp);
    const r2 = await c.lookup(fp);
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/invalid API key/);
    expect(calls).toBe(2); // error must not be cached
  });

  it('reports missing key without hitting the network', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return res({});
    }) as unknown as typeof fetch;
    const c = new AcoustIdClient({ apiKey: '', cacheDir: await cacheDir(), fetchImpl });
    const r = await c.lookup(fp);
    expect(r.ok).toBe(false);
    expect(c.hasKey()).toBe(false);
    expect(calls).toBe(0);
  });
});

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
});
