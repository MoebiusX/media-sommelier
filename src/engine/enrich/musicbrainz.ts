/**
 * MusicBrainz client — rate-limited, cached, ToS-compliant.
 *
 * Non-commercial/personal use (the locked product decision). MusicBrainz requires:
 *   - a descriptive User-Agent with contact info (enforced here, non-overridable),
 *   - <= ~1 request/second (we serialize with an 1100ms floor),
 *   - graceful backoff on 503.
 * Responses (incl. negative results) are cached on disk so re-runs and offline reuse never re-hit
 * the network. No API key needed for MusicBrainz search/lookup.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const USER_AGENT = 'MediaSommelier/0.1.0 ( https://github.com/MoebiusX/media-sommelier )';
const BASE = 'https://musicbrainz.org/ws/2';
const MIN_INTERVAL_MS = 1100;

export interface MBArtistCredit {
  name: string;
  joinphrase?: string;
}
export interface MBRelease {
  id: string;
  title: string;
  date?: string;
  country?: string;
  'track-count'?: number;
  'artist-credit'?: MBArtistCredit[];
  'release-group'?: { id: string; 'primary-type'?: string };
  score?: number;
}

export interface MusicBrainzClientOptions {
  cacheDir?: string;
  /** If true, never hit the network — only serve cached results (offline mode). */
  offline?: boolean;
  /** Injected fetch for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class MusicBrainzClient {
  private cacheDir: string;
  private offline: boolean;
  private fetchImpl: typeof fetch;
  private lastCall = 0;
  private chain: Promise<unknown> = Promise.resolve();
  public stats = { network: 0, cacheHits: 0, errors: 0 };

  constructor(opts: MusicBrainzClientOptions = {}) {
    this.cacheDir = opts.cacheDir ?? 'data/mb-cache';
    this.offline = opts.offline ?? false;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Search releases by artist + album. Returns [] on no match / offline-miss / error. */
  async searchReleases(artist: string, album: string, limit = 8): Promise<MBRelease[]> {
    const query = `release:"${escapeLucene(album)}" AND artist:"${escapeLucene(artist)}"`;
    const url = `${BASE}/release?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`;
    const body = await this.getJson(url);
    return (body?.releases as MBRelease[] | undefined) ?? [];
  }

  private async getJson(url: string): Promise<Record<string, unknown> | null> {
    const cached = await this.readCache(url);
    if (cached !== undefined) {
      this.stats.cacheHits++;
      return cached;
    }
    if (this.offline) return null;

    // serialize + throttle to honor the rate limit
    const run = this.chain.then(async () => {
      const wait = MIN_INTERVAL_MS - (Date.now() - this.lastCall);
      if (wait > 0) await delay(wait);
      this.lastCall = Date.now();
      this.stats.network++;
      const res = await this.fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
      if (res.status === 503) {
        await delay(2000);
        const retry = await this.fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
        return retry.ok ? ((await retry.json()) as Record<string, unknown>) : null;
      }
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    });
    this.chain = run.catch(() => undefined);

    let json: Record<string, unknown> | null = null;
    try {
      json = await run;
    } catch {
      this.stats.errors++;
      json = null;
    }
    await this.writeCache(url, json); // cache negatives too
    return json;
  }

  private cachePath(url: string): string {
    const key = createHash('sha1').update(url).digest('hex');
    return join(this.cacheDir, `${key}.json`);
  }
  private async readCache(url: string): Promise<Record<string, unknown> | null | undefined> {
    try {
      const raw = await readFile(this.cachePath(url), 'utf8');
      return JSON.parse(raw) as Record<string, unknown> | null;
    } catch {
      return undefined; // not cached
    }
  }
  private async writeCache(url: string, json: Record<string, unknown> | null): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(this.cachePath(url), JSON.stringify(json), 'utf8');
    } catch {
      /* cache write best-effort */
    }
  }
}

function escapeLucene(s: string): string {
  return s.replace(/(["\\])/g, '\\$1').replace(/[+\-!(){}[\]^~*?:]/g, ' ').replace(/\s+/g, ' ').trim();
}
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
