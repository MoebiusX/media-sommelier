/**
 * Map a free-text genre tag to a coarse {style, mood} class — the offline signal that powers Auto DJ.
 * Pure + deterministic + network-free (invariants I2/I3). Real collections tag genre as messy strings
 * ("Dance-Pop/House/Eurodance", "general electronic", "alternative"); we classify by the first matching
 * keyword so compound and noisy tags still land somewhere sensible. Unknown/noise tags ("other",
 * "misc", "desconocido") match nothing and return null — the caller treats those as "no signal".
 */

export type StyleFamily =
  | 'rock'
  | 'pop'
  | 'electronic'
  | 'hiphop'
  | 'rnbsoul'
  | 'jazzblues'
  | 'classical'
  | 'folkcountry'
  | 'latin'
  | 'world'
  | 'soundtrack'
  | 'ambient'
  | 'metal';

export type Mood = 'chill' | 'upbeat' | 'energetic' | 'intense' | 'melancholy' | 'focus' | 'romantic';

export interface GenreClass {
  style: StyleFamily;
  mood: Mood;
}

export const STYLE_LABELS: Record<StyleFamily, string> = {
  rock: 'Rock',
  pop: 'Pop',
  electronic: 'Electronic',
  hiphop: 'Hip-Hop',
  rnbsoul: 'R&B / Soul',
  jazzblues: 'Jazz & Blues',
  classical: 'Classical',
  folkcountry: 'Folk & Country',
  latin: 'Latin',
  world: 'World',
  soundtrack: 'Soundtrack',
  ambient: 'Ambient',
  metal: 'Metal',
};

export const MOOD_LABELS: Record<Mood, string> = {
  chill: 'Chill',
  upbeat: 'Upbeat',
  energetic: 'Energetic',
  intense: 'Intense',
  melancholy: 'Melancholy',
  focus: 'Focus',
  romantic: 'Romantic',
};

export function isStyleFamily(s: string | null | undefined): s is StyleFamily {
  return !!s && s in STYLE_LABELS;
}
export function isMood(s: string | null | undefined): s is Mood {
  return !!s && s in MOOD_LABELS;
}

interface Rule {
  kw: string[];
  style: StyleFamily;
  mood: Mood;
}

// Order matters: most specific first. The first rule with any keyword found as a substring wins, so
// "hard rock" reaches the rock rule (it has no earlier keyword) while "death metal" stops at metal.
const RULES: Rule[] = [
  { kw: ['metal', 'thrash', 'black metal', 'death metal'], style: 'metal', mood: 'intense' },
  { kw: ['grunge', 'punk', 'hardcore'], style: 'metal', mood: 'intense' },
  { kw: ['hip-hop', 'hip hop', 'hiphop', 'rap', 'trap'], style: 'hiphop', mood: 'energetic' },
  { kw: ['r&b', 'rnb', 'r and b', 'soul', 'funk', 'motown'], style: 'rnbsoul', mood: 'romantic' },
  { kw: ['ambient', 'new age', 'chillout', 'chill out', 'downtempo', 'lounge', 'easy listening', 'meditation'], style: 'ambient', mood: 'chill' },
  { kw: ['reggae', 'dancehall', 'ska', 'dub'], style: 'world', mood: 'chill' },
  { kw: ['house', 'techno', 'trance', 'dance', 'electro', 'edm', 'club', 'disco', 'eurodance', 'makina', 'italodance', 'dubstep', 'dnb'], style: 'electronic', mood: 'energetic' },
  { kw: ['soundtrack', 'sound track', 'score', 'banda sonora', 'ost'], style: 'soundtrack', mood: 'focus' },
  { kw: ['classical', 'orchestr', 'opera', 'baroque', 'symphony', 'choral'], style: 'classical', mood: 'focus' },
  { kw: ['blues'], style: 'jazzblues', mood: 'melancholy' },
  { kw: ['jazz', 'swing', 'bebop'], style: 'jazzblues', mood: 'chill' },
  { kw: ['latin', 'salsa', 'reggaeton', 'bachata', 'merengue', 'cumbia', 'flamenco', 'tango', 'ranchera', 'mariachi', 'bolero', 'rumba', 'latino'], style: 'latin', mood: 'upbeat' },
  { kw: ['world', 'celtic', 'afro', 'fusion', 'folklore', 'ethnic', 'bhangra'], style: 'world', mood: 'upbeat' },
  { kw: ['synthpop', 'synth pop', 'new wave'], style: 'pop', mood: 'upbeat' },
  { kw: ['folk', 'country', 'bluegrass', 'americana', 'singer-songwriter'], style: 'folkcountry', mood: 'chill' },
  { kw: ['alternative', 'alt-rock', 'alt rock'], style: 'rock', mood: 'melancholy' },
  { kw: ['indie'], style: 'rock', mood: 'upbeat' },
  { kw: ['pop'], style: 'pop', mood: 'upbeat' },
  { kw: ['hard rock', 'classic rock', 'rock'], style: 'rock', mood: 'energetic' },
];

/** Classify a genre tag into a {style, mood} family, or null if it carries no usable signal. */
export function classifyGenre(genre: string | null | undefined): GenreClass | null {
  if (!genre) return null;
  const s = genre.toLowerCase();
  for (const r of RULES) {
    for (const k of r.kw) {
      if (s.includes(k)) return { style: r.style, mood: r.mood };
    }
  }
  return null;
}
