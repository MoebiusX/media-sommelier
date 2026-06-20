// Simulate album-grouping methods over a real folder and count orphans (albums with <= 2 tracks).
//   npx tsx tools/_sim-grouping.ts "Y:/path/to/music"
import { scanLibrary, reconstruct, normalize } from '../src/engine/index.js';
import type { Track } from '../src/engine/index.js';

const root = process.argv[2];
if (!root) throw new Error('pass a folder');
process.stderr.write(`scanning + reading tags under ${root} …\n`);
const tracks = await scanLibrary(root, { concurrency: 10, onProgress: (d, t) => { if (d % 200 === 0) process.stderr.write(`\r  ${d}/${t}`); } });
process.stderr.write(`\r  ${tracks.length} tracks\n\n`);

const stats = (sizes: number[]) => {
  const albums = sizes.length;
  const orphans = sizes.filter((n) => n <= 2).length;
  const singletons = sizes.filter((n) => n === 1).length;
  return { albums, orphans, singletons, orphanPct: albums ? Math.round((orphans / albums) * 100) : 0 };
};
const group = (keyOf: (t: Track) => string) => {
  const m = new Map<string, number>();
  for (const t of tracks) { const k = keyOf(t); m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.values()];
};

const artistOf = (t: Track) => (t.albumArtist || t.artist || '?').toLowerCase();
const normAlbum = (a?: string) =>
  normalize((a ?? '').replace(/\(?\b(disc|cd|disco|vol|volume)\b\s*\.?\s*\d+\)?/gi, '').replace(/\[[^\]]*\]/g, '').replace(/\((?:remaster|deluxe|expanded|reissue)[^)]*\)/gi, ''));

// 1) raw embedded album tag (what tag-based players do); no-album falls back to its folder
const m1 = group((t) => (t.album ? artistOf(t) + '|' + t.album.toLowerCase() : 'dir:' + t.dir));
// 2) normalized album tag (merge "(Disc 1)" / "[Remastered]" / casing variants)
const m2 = group((t) => { const na = normAlbum(t.album); return na ? normalize(artistOf(t)) + '|' + na : 'dir:' + t.dir; });
// 3) source folder = album (the engine's basis), no merge
const m3 = group((t) => t.dir.toLowerCase());
// 4) full reconstruction (folder cohesion + multi-disc sibling/parent merges)
const m4 = reconstruct(tracks).candidates.map((c) => c.totalTracks);

const rows: Array<[string, ReturnType<typeof stats>]> = [
  ['1. raw album tag', stats(m1)],
  ['2. normalized album tag', stats(m2)],
  ['3. source folder', stats(m3)],
  ['4. reconstruction (folder + merges)', stats(m4)],
];
console.log('method                                 albums  orphans(<=2)  singletons  orphan%');
for (const [name, s] of rows)
  console.log(name.padEnd(38), String(s.albums).padStart(6), String(s.orphans).padStart(12), String(s.singletons).padStart(11), String(s.orphanPct).padStart(7) + '%');
const best = rows.slice().sort((a, b) => a[1].orphanPct - b[1].orphanPct)[0]!;
console.log(`\n→ fewest orphans: ${best[0]} (${best[1].orphanPct}% orphan albums)`);
