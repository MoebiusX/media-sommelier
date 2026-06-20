#!/usr/bin/env node
// Quick-scan a Windows `dir /s` dump and report the kind of insights sabiorg's
// engine will produce: per-album facts, naming-scheme entropy, duplicate
// candidates, build-history, and broken album-integrity signals.
//
// This is a throwaway diagnostic over a *directory listing only* (no tag/audio
// reads), deliberately conservative: anything it cannot know from names+sizes
// alone is flagged as "needs fingerprint/header read", which is exactly what the
// real engine does next.
//
// Usage: node tools/scan-dirlisting.mjs <dir-listing.txt>

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('usage: scan-dirlisting.mjs <listing.txt>'); process.exit(1); }
const raw = readFileSync(path, 'utf8');

const AUDIO = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma', 'aiff', 'alac']);
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic']);
const JUNK = new Set(['db', 'ini', 'ds_store', 'nfo', 'm3u', 'm3u8', 'log', 'txt']);

const fileLine = /^(\d{2})\/(\d{2})\/(\d{4})\s+\d{2}:\d{2}\s+(?:AM|PM)\s+([\d,]+)\s+(.+?)\s*$/;
const dirOf = /^\s*Directory of\s+(.+?)\s*$/;

let cur = null;
const dirs = new Map(); // path -> { files:[{name,size,mtime,ext}] }
for (const line of raw.split(/\r?\n/)) {
  const d = line.match(dirOf);
  if (d) { cur = d[1]; if (!dirs.has(cur)) dirs.set(cur, { files: [] }); continue; }
  if (line.includes('<DIR>')) continue;
  const m = line.match(fileLine);
  if (m && cur) {
    const [, mm, dd, yyyy, sizeStr, name] = m;
    if (name === '.' || name === '..') continue;
    const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
    dirs.get(cur).files.push({ name, size: +sizeStr.replace(/,/g, ''), mtime: `${yyyy}-${mm}-${dd}`, ext });
  }
}

const human = (b) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

// --- naming scheme classifier (best-effort, over basename w/o extension) ---
function scheme(name) {
  const b = name.replace(/\.[^.]+$/, '');
  if (/^\d{3}-[a-z0-9_]+-[a-z0-9_]+/.test(b)) return 'discTrack_artist_title (101-artist-title)';
  if (/^\d{1,2}\s*-\s*.+?\s*-\s*.+/.test(b)) return 'track - ARTIST - Title';
  if (/\(\d{1,2}\)/.test(b)) return 'Artist - (NN)Title';
  if (/^\d{1,2}\s*[-.]\s*\D/.test(b)) return 'track - Title';
  if (/^[A-Za-z].+\s-\s.+/.test(b)) return 'Artist - Title (no track #)';
  return 'other/unknown';
}

// --- title normaliser for cross-album duplicate detection ---
function titleKey(name) {
  let b = name.replace(/\.[^.]+$/, '').toLowerCase();
  b = b.replace(/^\d{1,3}\s*[-.)]?\s*/, '');          // leading track/disc number
  b = b.replace(/\(\d{1,2}\)/g, '');                  // (NN)
  b = b.replace(/^[a-z .&']+?\s-\s/, '');             // leading "artist - "
  b = b.replace(/[_]+/g, ' ');
  b = b.replace(/[^a-z0-9 ]+/g, '');                  // punctuation
  b = b.replace(/\b(part|pt)\b.*$/, '');              // trailing "part .."
  b = b.replace(/\s+(edit|remix|remaster(ed)?|live|version|mix)\b.*$/, '');
  return b.replace(/\s+/g, ' ').trim();
}

// --- aggregate ---
let totAudio = 0, totBytes = 0;
const extCount = {}, schemeCount = {}, mtimeCount = {};
const titleIndex = new Map(); // titleKey -> [{dir,name}]
const albums = []; // dirs with >=1 audio file

for (const [p, { files }] of dirs) {
  const audio = files.filter(f => AUDIO.has(f.ext));
  for (const f of files) extCount[f.ext || '(none)'] = (extCount[f.ext || '(none)'] || 0) + 1;
  if (audio.length === 0) continue;
  const leaf = p.split('\\').pop();
  let bytes = 0, withTrack = 0; const schemes = new Set();
  for (const f of audio) {
    bytes += f.size; totBytes += f.size; totAudio++;
    mtimeCount[f.mtime] = (mtimeCount[f.mtime] || 0) + 1;
    const s = scheme(f.name); schemes.add(s); schemeCount[s] = (schemeCount[s] || 0) + 1;
    if (/^\d{1,3}\s*[-.()]/.test(f.name)) withTrack++;
    const k = titleKey(f.name);
    if (!titleIndex.has(k)) titleIndex.set(k, []);
    titleIndex.get(k).push({ dir: leaf, name: f.name, size: f.size });
  }
  const hasCover = files.some(f => IMAGE.has(f.ext));
  albums.push({
    path: p, leaf, count: audio.length, bytes,
    avgMB: bytes / audio.length / 1048576,
    trackNumPct: Math.round((withTrack / audio.length) * 100),
    hasCover, schemes: [...schemes], firstFile: audio[0].name,
  });
}

// --- split-release / multi-disc detection ---
function discStem(leaf) {
  return leaf
    .replace(/\s*\(?\b(cd|disc|disco|volume|vol)\b\s*\d+\)?/ig, '')
    .replace(/\s*\(?\bvolume\d+\)?/ig, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}
const stemGroups = new Map();
for (const a of albums) {
  const isDisc = /\b(cd|disc|disco|volume|vol)\b\s*\d+|\bvolume\d+/i.test(a.leaf);
  const stem = isDisc ? discStem(a.leaf) : null;
  if (stem) { if (!stemGroups.has(stem)) stemGroups.set(stem, []); stemGroups.get(stem).push(a); }
}

// --- output ---
const L = console.log;
L('# Quick scan (directory-listing only)\n');
L(`Source: ${path}`);
L(`Audio files: **${totAudio}**   |   Audio bytes: **${human(totBytes)}**   |   Album-folders: **${albums.length}**\n`);

L('## Format / volume');
const audioExts = Object.entries(extCount).filter(([e]) => AUDIO.has(e));
const lossless = audioExts.filter(([e]) => ['flac','wav','alac','aiff'].includes(e)).reduce((s,[,c])=>s+c,0);
L(`Lossless ratio: **${((lossless/totAudio)*100).toFixed(1)}%** (${lossless}/${totAudio})`);
L('Extensions: ' + Object.entries(extCount).sort((a,b)=>b[1]-a[1]).map(([e,c])=>`\`${e||'(none)'}\`×${c}`).join(', '));
const avgAll = totBytes/totAudio/1048576;
L(`Avg track size: **${avgAll.toFixed(1)} MB**  → at a typical ~4 min/track that implies roughly ~${Math.round(avgAll*1048576*8/240/1000)} kbps MP3 (header read needed to confirm).\n`);

L('## Naming-scheme entropy (the core mess)');
L(`Distinct schemes seen across the set: **${Object.keys(schemeCount).length}**`);
for (const [s,c] of Object.entries(schemeCount).sort((a,b)=>b[1]-a[1])) L(`- ${c.toString().padStart(3)}×  ${s}`);
L('');

L('## Album-integrity signals');
L('### Split releases (disc/volume folders that should be ONE release)');
let foundSplit = false;
for (const [stem, group] of stemGroups) {
  if (group.length >= 2) {
    foundSplit = true;
    const tot = group.reduce((s,a)=>s+a.count,0);
    L(`- **${stem}** → ${group.length} folders, ${tot} tracks total:`);
    for (const a of group) L(`    - \`${a.leaf}\` (${a.count} tracks)`);
  }
}
if (!foundSplit) L('- none detected by leaf-name heuristic');
L('\n### Orphans (album-folder with a single track — likely a stripped album)');
for (const a of albums.filter(a => a.count === 1)) L(`- \`${a.leaf}\` — only "${a.firstFile}"`);
L('\n### Missing track numbers (original sequence lost)');
for (const a of albums.filter(a => a.trackNumPct === 0)) L(`- \`${a.leaf}\` — 0% of ${a.count} tracks carry a track number`);
L('');

L('## Duplicate candidates (same normalised title in >1 folder — verify by fingerprint)');
const SUFFIX_NOISE = new Set(['edit', 'remix', 'live', 'remaster', 'version', 'mix', 'intro', 'outro', 'demo']);
const dups = [...titleIndex.entries()]
  .filter(([k, v]) => v.length > 1 && k.split(' ').length >= 2 && !SUFFIX_NOISE.has(k));
if (dups.length === 0) L('- none');
for (const [k, v] of dups.sort((a,b)=>b[1].length-a[1].length)) {
  L(`- **${k}** ×${v.length}: ` + v.map(x => `\`${x.dir}\``).join(' , '));
}
L('');

L('## Build history (file mtimes = copy events, NOT original acquisition)');
for (const [d,c] of Object.entries(mtimeCount).sort()) L(`- ${d}: ${c} files`);

L('\n## Per-album detail');
L('| Album folder | Tracks | Size | Avg/track | Track #s | Cover | Scheme |');
L('|---|--:|--:|--:|--:|:-:|---|');
for (const a of albums.sort((x,y)=>y.count-x.count)) {
  L(`| ${a.leaf} | ${a.count} | ${human(a.bytes)} | ${a.avgMB.toFixed(1)} MB | ${a.trackNumPct}% | ${a.hasCover?'✓':'—'} | ${a.schemes.join('; ')} |`);
}
