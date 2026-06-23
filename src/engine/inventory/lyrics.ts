/**
 * Lyrics for a track — OFFLINE + READ-ONLY (invariants I1/I3). Prefers a sidecar `.lrc`/`.txt` next to
 * the file (so user-supplied, time-synced lyrics win), then embedded tags (USLT plain / SYLT synced via
 * music-metadata). The source file is only ever read. Online lookup is NOT done here — that optional,
 * graceful-degrade layer lives in the app server, keeping this module network-free.
 */
import { parseFile } from 'music-metadata';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';

/** One time-synced lyric line. */
export interface LyricLine {
  /** Seconds from the start of the track. */
  time: number;
  text: string;
}

export interface Lyrics {
  /** Time-synced lines (karaoke), if available — sorted by time. */
  synced: LyricLine[] | null;
  /** Plain unsynced text, if available. */
  plain: string | null;
  /** Where the lyrics came from (null when nothing local was found). */
  source: 'sidecar' | 'embedded' | null;
}

const EMPTY: Lyrics = { synced: null, plain: null, source: null };

/** `[mm:ss]`, `[mm:ss.xx]` or `[mm:ss.xxx]` timestamp tag (LRC). */
const TS = /\[(\d{1,2}):(\d{2})(?:[.:](\d{2,3}))?\]/g;

/**
 * Parse an LRC body into time-synced lines. A single line may carry several timestamps (repeated
 * choruses) — each becomes its own entry. ID tags like `[ar:…]`/`[length:…]` carry no time and drop out.
 */
export function parseLrc(body: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of body.split(/\r?\n/)) {
    TS.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = TS.exec(raw)) !== null) {
      const frac = m[3] ? Number(m[3]) / (m[3].length === 2 ? 100 : 1000) : 0;
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac);
    }
    if (stamps.length === 0) continue;
    const text = raw.replace(TS, '').trim();
    for (const t of stamps) out.push({ time: t, text });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** music-metadata's lyrics shape varies by version — normalize defensively rather than trust the type. */
type RawLyric = string | { text?: string; syncText?: Array<{ text?: string; timestamp?: number }> };

function fromEmbedded(tags: RawLyric[]): Lyrics | null {
  // Synced (SYLT) wins: timestamps come back in milliseconds.
  for (const l of tags) {
    if (typeof l === 'string') continue;
    const sync = l.syncText;
    if (sync && sync.length > 0) {
      const synced = sync
        .filter((s) => s.timestamp != null)
        .map((s) => ({ time: (s.timestamp ?? 0) / 1000, text: s.text ?? '' }))
        .sort((a, b) => a.time - b.time);
      if (synced.length > 0) return { synced, plain: synced.map((s) => s.text).join('\n'), source: 'embedded' };
    }
  }
  // Plain (USLT).
  for (const l of tags) {
    const text = (typeof l === 'string' ? l : l.text)?.trim();
    if (text) return { synced: null, plain: text, source: 'embedded' };
  }
  return null;
}

/** Read lyrics for one audio file (sidecar → embedded). Never throws; returns EMPTY when none found. */
export async function readLyrics(path: string): Promise<Lyrics> {
  // 1) Sidecar `.lrc` (ideal — usually synced) then `.txt`, matched on the file's stem.
  const stem = basename(path, extname(path));
  const dir = dirname(path);
  for (const ext of ['.lrc', '.txt']) {
    const p = join(dir, stem + ext);
    if (!existsSync(p)) continue;
    try {
      const body = await readFile(p, 'utf8');
      if (ext === '.lrc') {
        const synced = parseLrc(body);
        if (synced.length > 0) return { synced, plain: synced.map((l) => l.text).join('\n'), source: 'sidecar' };
      }
      if (body.trim()) return { synced: null, plain: body.trim(), source: 'sidecar' };
    } catch {
      /* unreadable sidecar — fall through */
    }
  }
  // 2) Embedded tags.
  try {
    const m = await parseFile(path, { duration: false, skipCovers: true });
    const tags = m.common.lyrics as unknown as RawLyric[] | undefined;
    if (tags && tags.length > 0) {
      const r = fromEmbedded(tags);
      if (r) return r;
    }
  } catch {
    /* unreadable/corrupt — no embedded lyrics */
  }
  return EMPTY;
}
