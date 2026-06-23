import { describe, it, expect } from 'vitest';
import { classifyGenre, autoDj, type DjTrack } from '../src/engine/index.js';

/** Deterministic LCG so the jittered sequencer is reproducible in tests. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('classifyGenre', () => {
  it('maps common genres to the right style/mood', () => {
    expect(classifyGenre('Rock')).toEqual({ style: 'rock', mood: 'energetic' });
    expect(classifyGenre('Pop')).toEqual({ style: 'pop', mood: 'upbeat' });
    expect(classifyGenre('House')).toEqual({ style: 'electronic', mood: 'energetic' });
    expect(classifyGenre('Classical')).toEqual({ style: 'classical', mood: 'focus' });
    expect(classifyGenre('Blues')).toEqual({ style: 'jazzblues', mood: 'melancholy' });
    expect(classifyGenre('Soul')).toEqual({ style: 'rnbsoul', mood: 'romantic' });
  });

  it('catches the most specific keyword first (metal before rock)', () => {
    expect(classifyGenre('Death Metal')?.style).toBe('metal');
    expect(classifyGenre('Hard Rock')).toEqual({ style: 'rock', mood: 'energetic' });
    expect(classifyGenre('Alternative')?.mood).toBe('melancholy');
  });

  it('handles messy compound + foreign tags', () => {
    expect(classifyGenre('Dance-Pop/House/Eurodance/Trance')?.style).toBe('electronic');
    expect(classifyGenre('general electronic')?.style).toBe('electronic');
  });

  it('returns null for noise / unknown tags', () => {
    expect(classifyGenre('Other')).toBeNull();
    expect(classifyGenre('desconocido')).toBeNull();
    expect(classifyGenre('')).toBeNull();
    expect(classifyGenre(null)).toBeNull();
  });
});

/** Build a pool: N artists × a genre, evenly spread, with years. */
function pool(): DjTrack[] {
  const out: DjTrack[] = [];
  let id = 1;
  const add = (artist: string, genre: string, year: number, n: number) => {
    for (let i = 0; i < n; i++) {
      out.push({
        id: id++,
        path: `${artist}/${genre}/${i}.mp3`,
        title: `${genre} ${i}`,
        artist,
        genre,
        year,
        durationMs: 200000,
        albumId: `${artist}-${genre}`,
        albumTitle: `${artist} ${genre}`,
      });
    }
  };
  add('RockBandA', 'Rock', 1995, 12);
  add('RockBandB', 'Hard Rock', 1998, 12);
  add('RockBandC', 'Alternative', 1994, 12);
  add('ChillCat', 'Jazz', 1980, 12);
  add('AmbientGuy', 'Ambient', 2010, 12);
  add('DJ One', 'House', 2005, 12);
  add('DJ Two', 'Techno', 2008, 12);
  return out;
}

describe('autoDj', () => {
  it('builds a queue of the requested length with no back-to-back same artist', () => {
    const set = autoDj(pool(), { mood: 'energetic', limit: 20, rng: lcg(42) });
    expect(set.picks.length).toBe(20);
    for (let i = 1; i < set.picks.length; i++) {
      expect(set.picks[i]!.artist).not.toBe(set.picks[i - 1]!.artist);
    }
    // never repeats a track
    expect(new Set(set.picks.map((p) => p.path)).size).toBe(set.picks.length);
  });

  it('respects a style target — picks stay on-style while the pool has matches', () => {
    const set = autoDj(pool(), { style: 'electronic', limit: 12, rng: lcg(7) });
    expect(set.target.style).toBe('electronic');
    // pool has 24 electronic tracks → a 12-track set should be all electronic
    for (const p of set.picks) {
      expect(classifyGenre(p.genre)?.style).toBe('electronic');
    }
  });

  it('places the seed first and anchors style from it', () => {
    const p = pool();
    const seed = p.find((t) => t.genre === 'House')!;
    const set = autoDj(p, { seed, limit: 10, rng: lcg(1) });
    expect(set.picks[0]!.path).toBe(seed.path);
    expect(set.target.style).toBe('electronic');
    expect(set.picks[0]!.reason).toContain('seed');
  });

  it('excludes already-played paths (endless extension)', () => {
    const p = pool();
    const first = autoDj(p, { style: 'rock', limit: 10, rng: lcg(3) });
    const played = first.picks.map((x) => x.path);
    const next = autoDj(p, { style: 'rock', limit: 10, exclude: played, rng: lcg(4) });
    for (const pick of next.picks) expect(played).not.toContain(pick.path);
  });

  it('attaches an evidence trace to each pick', () => {
    const set = autoDj(pool(), { mood: 'chill', style: 'jazzblues', limit: 5, rng: lcg(9) });
    expect(set.picks[0]!.reason.length).toBeGreaterThan(0);
  });
});
