/**
 * Offline album reconstruction — the V0 core.
 *
 * Takes a flat media inventory and rebuilds coherent release candidates using folder cohesion + the
 * parsed naming schemes, with three multi-disc merge strategies that cover the real failure modes in
 * the sample collection:
 *   1. inline-marker stems     — "Pink Floyd - Echoes Cd 1" + "...Cd 2" (siblings sharing a stem)
 *   2. dedicated-parent prefix — "Greatest Hits I/II/III", "...(volume1/2)" (siblings under one box)
 *   3. in-folder disc prefixes — "101-..."/"201-..." (one folder, disc encoded in the filename)
 *
 * Confidence is OFFLINE-CAPPED at 0.75: online fingerprint/MusicBrainz evidence is what unlocks higher
 * confidence and auto-accept in a later phase. Nothing here mutates files.
 */
import type {
  AlbumCandidate,
  CandidateFlag,
  DiscGroup,
  DuplicateCandidate,
  MediaFileRecord,
  ReconstructionReport,
  TrackSlot,
} from '../types.js';
import {
  basename,
  findYear,
  humanBytes,
  isAudioExt,
  isLosslessExt,
  normalize,
  stripDiscTokens,
  titleKey,
} from '../text.js';
import { parseName } from './parseName.js';

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 };
const COMPILATION_RE = /\b(greatest hits|best of|very best|the hits|platinum collection|collection|anthology|compilation|essential)\b/i;
const GENERIC_TITLE_KEYS = new Set(['intro', 'outro', 'untitled', 'track', 'interlude', 'bonus']);

interface FolderAlbum {
  dir: string;
  leaf: string;
  parentPath: string;
  files: MediaFileRecord[];
  /** disc number inferred from the folder itself (bare/inline marker), if any */
  folderDiscNo?: number;
  /** true if leaf is a bare "CD 2"/"Volume 1" style folder (album identity lives in the parent) */
  bareDisc: boolean;
  albumFolderName: string;
  releaseKey: string;
}

function parentOf(dir: string): string {
  const idx = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'));
  return idx > 0 ? dir.slice(0, idx) : dir;
}

function bareDiscNo(leaf: string): number | undefined {
  const m = leaf.match(/^(?:cd|disc|disco)\s*\.?\s*(\d+)$/i) || leaf.match(/^volume\s*\.?\s*(\d+)$/i);
  return m ? Number(m[1]) : undefined;
}

function inlineDiscNo(leaf: string): number | undefined {
  const m =
    leaf.match(/\((?:cd|disc|disco|volume|vol)\s*\.?\s*(\d+)\)/i) ||
    leaf.match(/\b(?:cd|disc|disco|volume|vol)\s*\.?\s*(\d+)\b/i) ||
    leaf.match(/\bvolume(\d+)\b/i);
  return m ? Number(m[1]) : undefined;
}

function commonWordPrefix(leaves: string[]): string {
  if (leaves.length === 0) return '';
  const split = leaves.map((l) => l.trim().split(/\s+/));
  const first = split[0]!;
  let n = first.length;
  for (const w of split) n = Math.min(n, w.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const word = first[i]!;
    if (split.every((w) => (w[i] ?? '').toLowerCase() === word.toLowerCase())) out.push(word);
    else break;
  }
  return out.join(' ').trim();
}

/** A short trailing token that looks like a disc indicator (roman/number/vol N). */
function discFromResidual(residual: string): number | undefined {
  const r = residual.trim().toLowerCase().replace(/[()]/g, '');
  if (r in ROMAN) return ROMAN[r];
  const dm = r.match(/^(?:vol(?:ume)?\s*)?(\d{1,2})$/);
  return dm ? Number(dm[1]) : undefined;
}

function guessArtist(fa: FolderAlbum): string {
  // 1) consistent artist parsed from filenames
  const counts = new Map<string, number>();
  for (const f of fa.files) {
    const a = parseName(f.name).artist;
    if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [a, n] of counts) if (n > bestN) ((best = a), (bestN = n));
  if (best && bestN >= Math.ceil(fa.files.length / 2)) return best;
  // 2) "Artist - Album" folder convention
  const src = fa.bareDisc ? basename(fa.parentPath) : fa.albumFolderName;
  const dash = src.indexOf(' - ');
  if (dash > 0) return src.slice(0, dash).trim();
  // 3) leading token of the folder name (e.g. "QUEEN Greatest Hits ...")
  return src.split(/\s+/)[0] ?? 'Unknown Artist';
}

/** Title-case a string only if it has no existing uppercase (fixes underscore-derived "led zeppelin"). */
function titleCaseIfLower(s: string): string {
  if (/[A-Z]/.test(s)) return s;
  return s.replace(/\b([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function albumTitleFrom(name: string, artist: string): string {
  let t = name;
  const dashPfx = `${artist} - `;
  if (t.toLowerCase().startsWith(dashPfx.toLowerCase())) t = t.slice(dashPfx.length);
  else if (t.toLowerCase().startsWith(`${artist.toLowerCase()} `)) t = t.slice(artist.length + 1); // "QUEEN Greatest Hits…"
  t = t.replace(/\([^)]*\b\d*\s*cd\b[^)]*\)/gi, ''); // "(Remasters 2CD)"
  t = stripDiscTokens(t);
  t = t.replace(/\b(19[0-9]{2}|20[0-9]{2})\b/g, '').trim();
  t = t.replace(/^[-\s]+|[-\s]+$/g, '');
  return t || name;
}

export function reconstruct(records: MediaFileRecord[]): ReconstructionReport {
  const audio = records.filter((r) => isAudioExt(r.ext));

  // --- group files into folder-albums ---
  const byDir = new Map<string, MediaFileRecord[]>();
  for (const r of audio) {
    if (!byDir.has(r.dir)) byDir.set(r.dir, []);
    byDir.get(r.dir)!.push(r);
  }
  const folderAlbums: FolderAlbum[] = [];
  for (const [dir, files] of byDir) {
    const leaf = basename(dir);
    const bare = bareDiscNo(leaf);
    const inline = inlineDiscNo(leaf);
    folderAlbums.push({
      dir,
      leaf,
      parentPath: parentOf(dir),
      files,
      folderDiscNo: bare ?? inline,
      bareDisc: bare != null,
      albumFolderName: bare != null ? basename(parentOf(dir)) : leaf,
      releaseKey: '', // assigned below
    });
  }

  // --- assign release keys (the three merge strategies) ---
  // Strategy 2 first: dedicated-parent prefix siblings (no inline marker, not bare).
  const plainByParent = new Map<string, FolderAlbum[]>();
  for (const fa of folderAlbums) {
    if (fa.bareDisc || fa.folderDiscNo != null) continue;
    if (!plainByParent.has(fa.parentPath)) plainByParent.set(fa.parentPath, []);
    plainByParent.get(fa.parentPath)!.push(fa);
  }
  const prefixAssigned = new Set<FolderAlbum>();
  for (const [parent, group] of plainByParent) {
    if (group.length < 2) continue;
    const prefix = commonWordPrefix(group.map((g) => g.leaf));
    if (prefix.length < 3) continue;
    const residuals = group.map((g) => g.leaf.slice(prefix.length).trim());
    const discs = residuals.map(discFromResidual);
    if (!discs.every((d) => d != null)) continue; // every sibling must look like a disc
    group.forEach((g, i) => {
      g.releaseKey = `prefix:${parent.toLowerCase()}:${normalize(prefix)}`;
      g.folderDiscNo = discs[i]!;
      g.albumFolderName = basename(parent);
      prefixAssigned.add(g);
    });
  }

  // Strategies 1 & 3 + singletons.
  for (const fa of folderAlbums) {
    if (prefixAssigned.has(fa)) continue;
    if (fa.bareDisc) {
      fa.releaseKey = `parent:${fa.parentPath.toLowerCase()}`;
    } else if (fa.folderDiscNo != null) {
      const artist = guessArtist(fa);
      const stemKey = normalize(stripDiscTokens(fa.albumFolderName));
      fa.releaseKey = `stem:${normalize(artist)}::${stemKey}`;
    } else {
      fa.releaseKey = `dir:${fa.dir.toLowerCase()}`;
    }
  }

  // --- build candidates per release key ---
  const byKey = new Map<string, FolderAlbum[]>();
  for (const fa of folderAlbums) {
    if (!byKey.has(fa.releaseKey)) byKey.set(fa.releaseKey, []);
    byKey.get(fa.releaseKey)!.push(fa);
  }

  const candidates: AlbumCandidate[] = [];
  const usedIds = new Set<string>();
  for (const [, group] of byKey) {
    candidates.push(buildCandidate(group, usedIds));
  }
  candidates.sort((a, b) => b.totalTracks - a.totalTracks);

  return {
    candidates,
    duplicates: findDuplicates(candidates),
    summary: summarize(audio, candidates),
  };
}

function buildCandidate(group: FolderAlbum[], usedIds: Set<string>): AlbumCandidate {
  const repr = group.find((g) => !g.bareDisc) ?? group[0]!;
  const artist = titleCaseIfLower(guessArtist(repr));
  const albumTitle = albumTitleFrom(repr.albumFolderName, artist);
  const allFiles = group.flatMap((g) => g.files);

  // assign each file to (disc, position)
  const slotsByDisc = new Map<number, { dirs: Set<string>; slots: TrackSlot[] }>();
  const schemes = new Set<string>();
  let hasAnyTrackNo = false;

  for (const fa of group) {
    const ordered = [...fa.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    ordered.forEach((file, idx) => {
      const parsed = parseName(file.name);
      schemes.add(parsed.scheme);
      if (parsed.hasTrackNo) hasAnyTrackNo = true;
      const discNo = parsed.discNo ?? fa.folderDiscNo ?? 1;
      const position = parsed.trackNo ?? idx + 1;
      const title = refineTitle(parsed.title ?? file.name, artist);
      if (!slotsByDisc.has(discNo)) slotsByDisc.set(discNo, { dirs: new Set(), slots: [] });
      const d = slotsByDisc.get(discNo)!;
      d.dirs.add(fa.dir);
      d.slots.push({ file, parsed, discNo, position, title });
    });
  }

  const discs: DiscGroup[] = [...slotsByDisc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([discNo, { dirs, slots }]) => {
      slots.sort((a, b) => a.position - b.position);
      const maxTrackNo = slots.reduce((m, s) => Math.max(m, s.parsed.trackNo ?? 0), 0);
      return { discNo, sourceDirs: [...dirs], tracks: slots, maxTrackNo };
    });

  const totalTracks = discs.reduce((n, d) => n + d.tracks.length, 0);
  const sizeBytes = allFiles.reduce((n, f) => n + f.sizeBytes, 0);
  const year = findYear(repr.albumFolderName) ?? findYear(repr.dir);

  // completeness
  let present = 0;
  let expected = 0;
  for (const d of discs) {
    if (d.maxTrackNo > 0) {
      present += d.tracks.length;
      expected += d.maxTrackNo;
    }
  }
  const completeness = expected > 0 ? Math.min(1, present / expected) : 0;

  // flags
  const flags: CandidateFlag[] = [];
  if (!hasAnyTrackNo) flags.push('no-track-numbers');
  if (totalTracks === 1) flags.push('orphan');
  if (group.length > 1) flags.push('multi-folder-merge');
  if (discs.length > 1 && group.length === 1) flags.push('in-folder-multi-disc');
  if (schemes.size > 1) flags.push('mixed-naming-schemes');
  const discNos = discs.map((d) => d.discNo);
  if (discNos.length > 0 && (Math.min(...discNos) > 1 || hasGaps(discNos))) flags.push('partial-disc-set');
  if (COMPILATION_RE.test(repr.albumFolderName) || COMPILATION_RE.test(albumTitle)) flags.push('possible-compilation');

  // confidence (offline-capped 0.75)
  let confidence = 0.4;
  if (hasAnyTrackNo) confidence += 0.15;
  if (completeness >= 0.9 && expected > 0) confidence += 0.1;
  if (group.length > 1) confidence += 0.05; // a real merge corroborated by sibling structure
  if (schemes.size > 1) confidence -= 0.1;
  if (flags.includes('orphan')) confidence = 0.3;
  if (flags.includes('partial-disc-set')) confidence -= 0.05;
  confidence = Math.max(0.1, Math.min(0.75, confidence));

  const evidence = buildEvidence(group, discs, totalTracks, hasAnyTrackNo, completeness, expected);
  const id = uniqueId(`${artist}-${albumTitle}`, usedIds);

  return {
    id,
    albumArtist: artist,
    albumTitle,
    ...(year != null ? { year } : {}),
    discs,
    totalTracks,
    completeness,
    confidence: round2(confidence),
    flags,
    evidence,
    schemes: [...schemes],
    sizeBytes,
  };
}

function refineTitle(rest: string, artist: string): string {
  // strip a leading "ARTIST - " the per-file parser couldn't disambiguate (e.g. "MIDNIGHT OIL - X")
  const na = normalize(artist);
  const dash = rest.indexOf(' - ');
  if (dash > 0 && normalize(rest.slice(0, dash)) === na) return rest.slice(dash + 3).trim();
  return rest.trim();
}

function hasGaps(discNos: number[]): boolean {
  const sorted = [...new Set(discNos)].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) if (sorted[i]! - sorted[i - 1]! > 1) return true;
  return false;
}

function buildEvidence(
  group: FolderAlbum[],
  discs: DiscGroup[],
  totalTracks: number,
  hasTrackNo: boolean,
  completeness: number,
  expected: number,
): string[] {
  const ev: string[] = [];
  if (group.length > 1) {
    ev.push(`Merged ${group.length} sibling folders into one release: ${group.map((g) => `"${g.leaf}"`).join(', ')}`);
  } else {
    ev.push(`All ${totalTracks} tracks share folder "${group[0]!.leaf}"`);
  }
  if (discs.length > 1) ev.push(`${discs.length} discs (${discs.map((d) => `${d.discNo}:${d.tracks.length}t`).join(', ')})`);
  const fromPrefix = discs.some((d) => d.tracks.some((t) => t.parsed.discNo != null));
  if (fromPrefix) ev.push('Disc numbers read from 3-digit filename prefixes (1xx/2xx)');
  if (hasTrackNo) {
    if (expected > 0) ev.push(`Track-order from filenames; completeness ~${Math.round(completeness * 100)}% (${expected} expected)`);
  } else {
    ev.push('No track numbers — order inferred from filename sort (sequence unverified)');
  }
  return ev;
}

function findDuplicates(candidates: AlbumCandidate[]): DuplicateCandidate[] {
  const index = new Map<string, DuplicateCandidate['occurrences']>();
  for (const c of candidates) {
    for (const d of c.discs) {
      for (const t of d.tracks) {
        const k = titleKey(t.title);
        if (k.split(' ').length < 2 || GENERIC_TITLE_KEYS.has(k)) continue;
        if (!index.has(k)) index.set(k, []);
        index.get(k)!.push({ candidateId: c.id, album: c.albumTitle, file: t.file.name, sizeBytes: t.file.sizeBytes });
      }
    }
  }
  const dups: DuplicateCandidate[] = [];
  for (const [k, occ] of index) {
    const albums = new Set(occ.map((o) => o.candidateId));
    if (albums.size > 1) dups.push({ titleKey: k, occurrences: occ });
  }
  return dups.sort((a, b) => b.occurrences.length - a.occurrences.length);
}

function summarize(audio: MediaFileRecord[], candidates: AlbumCandidate[]): ReconstructionReport['summary'] {
  const schemes: Record<string, number> = {};
  for (const c of candidates) for (const s of c.schemes) schemes[s] = (schemes[s] ?? 0) + 1;
  const lossless = audio.filter((a) => isLosslessExt(a.ext)).length;
  return {
    audioFiles: audio.length,
    audioBytes: audio.reduce((n, a) => n + a.sizeBytes, 0),
    candidates: candidates.length,
    multiDisc: candidates.filter((c) => c.discs.length > 1).length,
    orphans: candidates.filter((c) => c.flags.includes('orphan')).length,
    needsReview: candidates.filter((c) => c.confidence < 0.6 || c.flags.includes('partial-disc-set')).length,
    losslessRatio: audio.length ? lossless / audio.length : 0,
    schemes,
  };
}

function uniqueId(raw: string, used: Set<string>): string {
  const base = normalize(raw).replace(/\s+/g, '-').slice(0, 60) || 'release';
  let id = base;
  let i = 2;
  while (used.has(id)) id = `${base}-${i++}`;
  used.add(id);
  return id;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export { humanBytes };
