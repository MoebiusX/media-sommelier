/**
 * AcoustID lookup client — maps a Chromaprint fingerprint to MusicBrainz recordings/releases.
 *
 * Non-commercial use. Lookups require an APPLICATION API key (the `client` param), registered at
 * https://acoustid.org/new-application — this is NOT the account/"submit" key. Rate-limited (3/s),
 * cached on disk, descriptive User-Agent. The response parser is pure and unit-tested separately.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fingerprint } from './fpcalc.js';

const ENDPOINT = 'https://api.acoustid.org/v2/lookup';
const USER_AGENT = 'MediaSommelier/0.1.0 ( https://github.com/MoebiusX/media-sommelier )';
const MIN_INTERVAL_MS = 350; // ~3 req/s

export interface AcoustIdMatch {
  acoustId: string;
  score: number;
  recordingId?: string;
  recordingTitle?: string;
  artist?: string;
  releaseGroupId?: string;
  releaseGroupTitle?: string;
}
export interface AcoustIdResult {
  ok: boolean;
  error?: string;
  best?: AcoustIdMatch;
  matchCount: number;
}

/** Pure: extract the best match from an AcoustID lookup JSON response. */
export function parseLookupResponse(json: any): AcoustIdResult {
  if (!json || json.status !== 'ok') {
    return { ok: false, error: json?.error?.message ?? 'unknown AcoustID error', matchCount: 0 };
  }
  const results: any[] = Array.isArray(json.results) ? json.results : [];
  if (results.length === 0) return { ok: true, matchCount: 0 };
  const top = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  const rec = Array.isArray(top.recordings) ? top.recordings[0] : undefined;
  const rg = rec && Array.isArray(rec.releasegroups) ? rec.releasegroups[0] : undefined;
  const best: AcoustIdMatch = {
    acoustId: top.id,
    score: top.score ?? 0,
    ...(rec?.id ? { recordingId: rec.id } : {}),
    ...(rec?.title ? { recordingTitle: rec.title } : {}),
    ...(rec?.artists?.[0]?.name ? { artist: rec.artists[0].name } : {}),
    ...(rg?.id ? { releaseGroupId: rg.id } : {}),
    ...(rg?.title ? { releaseGroupTitle: rg.title } : {}),
  };
  return { ok: true, best, matchCount: results.length };
}

export interface AcoustIdClientOptions {
  apiKey?: string; // application/client key; falls back to ACOUSTID_API_KEY
  cacheDir?: string;
  fetchImpl?: typeof fetch;
}

export class AcoustIdClient {
  private apiKey: string;
  private cacheDir: string;
  private fetchImpl: typeof fetch;
  private lastCall = 0;
  private chain: Promise<unknown> = Promise.resolve();
  public stats = { network: 0, cacheHits: 0, errors: 0 };

  constructor(opts: AcoustIdClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ACOUSTID_API_KEY ?? '';
    this.cacheDir = opts.cacheDir ?? 'data/acoustid-cache';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  hasKey(): boolean {
    return this.apiKey.length > 0;
  }

  async lookup(fp: Fingerprint): Promise<AcoustIdResult> {
    if (!this.apiKey) return { ok: false, error: 'no ACOUSTID_API_KEY (application key) configured', matchCount: 0 };
    const cacheKey = createHash('sha1').update(`${fp.duration}:${fp.fingerprint}`).digest('hex');
    const cached = await this.readCache(cacheKey);
    if (cached) {
      this.stats.cacheHits++;
      return parseLookupResponse(cached);
    }

    const body = new URLSearchParams({
      client: this.apiKey,
      duration: String(fp.duration),
      fingerprint: fp.fingerprint,
      meta: 'recordings+releasegroups',
    });

    const run = this.chain.then(async () => {
      const wait = MIN_INTERVAL_MS - (Date.now() - this.lastCall);
      if (wait > 0) await delay(wait);
      this.lastCall = Date.now();
      this.stats.network++;
      const res = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      return (await res.json()) as Record<string, unknown>;
    });
    this.chain = run.catch(() => undefined);

    let json: Record<string, unknown> | null = null;
    try {
      json = await run;
    } catch {
      this.stats.errors++;
      return { ok: false, error: 'network error', matchCount: 0 };
    }
    await this.writeCache(cacheKey, json);
    return parseLookupResponse(json);
  }

  private cachePath(key: string): string {
    return join(this.cacheDir, `${key}.json`);
  }
  private async readCache(key: string): Promise<Record<string, unknown> | undefined> {
    try {
      return JSON.parse(await readFile(this.cachePath(key), 'utf8'));
    } catch {
      return undefined;
    }
  }
  private async writeCache(key: string, json: unknown): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(this.cachePath(key), JSON.stringify(json), 'utf8');
    } catch {
      /* best-effort */
    }
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
