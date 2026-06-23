/**
 * Auto DJ: build a coherent, endless-feeling queue from a track pool, anchored on a mood/style/seed.
 * Pure + offline (invariants I2/I3). It greedily sequences tracks by:
 *   - affinity to the target (style/mood/era),
 *   - flow vs the PREVIOUS pick (don't lurch between styles/eras),
 *   - artist diversity (no back-to-back same artist; spread artists across the set),
 *   - a little jitter so two sessions of the same mood differ.
 * Every pick carries a `reason[]` trace (the project's evidence ethos). The RNG is injectable so tests
 * are deterministic.
 */
import {
  classifyGenre,
  isMood,
  isStyleFamily,
  MOOD_LABELS,
  STYLE_LABELS,
  type GenreClass,
  type Mood,
  type StyleFamily,
} from './genreMood.js';

export interface DjTrack {
  id: number;
  path: string;
  title: string;
  artist: string | null;
  genre: string | null;
  year: number | null;
  durationMs: number | null;
  albumId: string | null;
  albumTitle: string | null;
}

export interface DjOptions {
  /** Seed track: it plays first and anchors the set's style/mood/era. */
  seed?: DjTrack;
  /** Target mood (overrides the seed's mood when both are given). */
  mood?: Mood;
  /** Target style family (overrides the seed's style when both are given). */
  style?: StyleFamily;
  /** Max tracks to return (clamped 1..200). */
  limit?: number;
  /** Track paths to never (re-)pick — the already-played/queued set, for endless extension. */
  exclude?: Iterable<string>;
  /** Deterministic RNG for tests; defaults to Math.random. */
  rng?: () => number;
}

export interface DjPick extends DjTrack {
  /** Why this track was chosen, e.g. ["style: Rock", "mood: Energetic", "era: 1990s"]. */
  reason: string[];
}

export interface DjSet {
  target: { mood?: Mood; style?: StyleFamily; label: string };
  picks: DjPick[];
}

const decadeOf = (y: number | null): number | null => (y && y > 0 ? Math.floor(y / 10) * 10 : null);
const artistKey = (a: string | null): string => (a ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

interface Candidate {
  t: DjTrack;
  c: GenreClass | null;
  base: number;
}

/** Sequence a pool into a mood/style-coherent DJ set. */
export function autoDj(pool: DjTrack[], opts: DjOptions = {}): DjSet {
  const rng = opts.rng ?? Math.random;
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 200));
  const exclude = new Set(opts.exclude ?? []);

  const classed = pool.map((t) => ({ t, c: classifyGenre(t.genre) }));

  // --- resolve the target profile ---
  let targetStyle: StyleFamily | undefined = isStyleFamily(opts.style) ? opts.style : undefined;
  let targetMood: Mood | undefined = isMood(opts.mood) ? opts.mood : undefined;
  let targetDecade: number | null = null;
  if (opts.seed) {
    const sc = classifyGenre(opts.seed.genre);
    if (sc) {
      targetStyle = targetStyle ?? sc.style;
      targetMood = targetMood ?? sc.mood;
    }
    targetDecade = decadeOf(opts.seed.year);
  }
  // "Surprise me": no anchor at all → pick a random classified track as the anchor.
  if (!targetStyle && !targetMood && !opts.seed) {
    const anchors = classed.filter((x) => x.c && !exclude.has(x.t.path));
    const a = anchors[Math.floor(rng() * anchors.length)];
    if (a && a.c) {
      targetStyle = a.c.style;
      targetMood = a.c.mood;
      targetDecade = decadeOf(a.t.year);
    }
  }

  const label =
    targetMood && targetStyle
      ? `${MOOD_LABELS[targetMood]} ${STYLE_LABELS[targetStyle]}`
      : targetStyle
        ? STYLE_LABELS[targetStyle]
        : targetMood
          ? MOOD_LABELS[targetMood]
          : 'Auto DJ';

  // --- base affinity to the target ---
  const affinity = (t: DjTrack, c: GenreClass | null): number => {
    let s = 0;
    if (c) {
      if (targetStyle && c.style === targetStyle) s += 3;
      if (targetMood && c.mood === targetMood) s += 2;
      if (!targetStyle && !targetMood) s += 1; // no target → any classified track is fair game
    }
    if (targetDecade != null) {
      const d = decadeOf(t.year);
      if (d != null && Math.abs(d - targetDecade) <= 10) s += 1;
    }
    return s;
  };

  const all: Candidate[] = classed
    .filter((x) => !exclude.has(x.t.path) && (!opts.seed || x.t.path !== opts.seed.path))
    .map((x) => ({ t: x.t, c: x.c, base: affinity(x.t, x.c) }));

  // Candidate pool, widening gracefully so a thin mood still fills the queue:
  // on-target first, then any classified track, then anything playable.
  let usable = all.filter((x) => x.base > 0);
  if (usable.length < limit) usable = usable.concat(all.filter((x) => x.base === 0 && x.c).map((x) => ({ ...x, base: 0.1 })));
  if (usable.length < limit) usable = usable.concat(all.filter((x) => !x.c).map((x) => ({ ...x, base: 0.01 })));

  // --- greedy flow sequencing ---
  const picks: DjPick[] = [];
  const used = new Set<string>();
  const artistCount = new Map<string, number>();
  let prev: { c: GenreClass | null; year: number | null; artist: string } | null = null;

  const note = (key: string) => artistCount.set(key, (artistCount.get(key) ?? 0) + 1);

  if (opts.seed && !exclude.has(opts.seed.path)) {
    const sc = classifyGenre(opts.seed.genre);
    picks.push({ ...opts.seed, reason: ['seed'] });
    used.add(opts.seed.path);
    note(artistKey(opts.seed.artist));
    prev = { c: sc, year: opts.seed.year, artist: artistKey(opts.seed.artist) };
  }

  while (picks.length < limit) {
    let best: { cand: Candidate; score: number; reason: string[] } | null = null;
    for (const x of usable) {
      if (used.has(x.t.path)) continue;
      const ak = artistKey(x.t.artist);
      const reason: string[] = [];
      let score = x.base;
      if (x.c) {
        if (targetStyle && x.c.style === targetStyle) reason.push(`style: ${STYLE_LABELS[x.c.style]}`);
        if (targetMood && x.c.mood === targetMood) reason.push(`mood: ${MOOD_LABELS[x.c.mood]}`);
      }
      if (prev) {
        if (prev.c && x.c && prev.c.style === x.c.style) score += 1;
        if (prev.c && x.c && prev.c.mood === x.c.mood) score += 0.5;
        const pd = decadeOf(prev.year);
        const xd = decadeOf(x.t.year);
        if (pd != null && xd != null && Math.abs(pd - xd) <= 10) score += 0.5;
        if (prev.artist && ak && prev.artist === ak) score -= 6; // never back-to-back same artist
      }
      score -= (artistCount.get(ak) ?? 0) * 1.5; // spread artists across the whole set
      score += rng() * 0.8; // jitter
      if (!best || score > best.score) best = { cand: x, score, reason };
    }
    if (!best) break;
    const { cand, reason } = best;
    used.add(cand.t.path);
    note(artistKey(cand.t.artist));
    const d = decadeOf(cand.t.year);
    picks.push({ ...cand.t, reason: d != null ? [...reason, `era: ${d}s`] : reason });
    prev = { c: cand.c, year: cand.t.year, artist: artistKey(cand.t.artist) };
  }

  return {
    target: { ...(targetMood ? { mood: targetMood } : {}), ...(targetStyle ? { style: targetStyle } : {}), label },
    picks,
  };
}
