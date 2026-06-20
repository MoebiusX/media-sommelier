/**
 * Organize planner — produces a DRY-RUN copy plan from reconstructed candidates.
 *
 * V0 plans but does NOT execute: it maps every source file to a clean destination path under a new
 * tree, with cross-platform-safe names. Source files are never touched. Execution (copy → verify →
 * tag-the-copy → journal) is a later phase; this is the preview the user confirms.
 */
import type { AlbumCandidate, DiscGroup, TrackSlot } from '../types.js';
import { extOf, normalize } from '../text.js';
import type { TrackTags } from './tag.js';

/** MusicBrainz/AcoustID-derived corrections for a candidate, keyed into OrganizeOptions.enrichment. */
export interface AlbumEnrichment {
  artist?: string;
  album?: string;
  year?: number;
  mbReleaseId?: string;
  mbReleaseGroupId?: string;
  /** Corrected per-track titles, keyed `${discNo}:${position}`. */
  trackTitles?: Map<string, string>;
  /**
   * Authoritative tracklist from the matched release (MusicBrainz `media[]` positions), if fetched.
   * Used to recover disc structure when reconstruction collapsed a multi-disc release into one disc
   * (e.g. two discs whose track numbers both restart at 1 in a single source folder).
   */
  tracklist?: Array<{ disc: number; position: number; title: string }>;
}

export interface OrganizeOptions {
  destRoot: string;
  /** Path separator for the destination (default '/'). */
  sep?: string;
  /** Only include candidates at/above this confidence (default 0: include all). */
  minConfidence?: number;
  /** Max full destination path length; over-long destinations are skipped (default 255, ~Windows MAX_PATH). */
  maxPathLength?: number;
  /** Enrichment overrides by candidate id — when present, drive both the dest path and the written tags. */
  enrichment?: Map<string, AlbumEnrichment>;
  /**
   * Folder/file naming template. Tokens: {albumArtist} {artist} {album} {year} {disc} {track} {title}.
   * `/` separates folders; the last segment is the filename (extension appended automatically).
   * Empty tokens (e.g. unknown {year}, single-disc {disc}) collapse away. Defaults to ORGANIZE_PRESETS['artist-year-album'].
   * A "Disc N" folder is auto-inserted for multi-disc releases even if the template omits {disc}, to avoid collisions.
   */
  template?: string;
}

/** Ready-made organize schemes the UI offers. */
export const ORGANIZE_PRESETS: Record<string, { label: string; template: string }> = {
  'artist-year-album': { label: 'Artist / [Year] Album / NN - Title', template: '{albumArtist}/{year} {album}/{disc}/{track} - {title}' },
  'artist-album': { label: 'Artist / Album / NN - Title', template: '{albumArtist}/{album}/{track} - {title}' },
  'compilation': { label: 'Artist / Album / NN - Track Artist - Title', template: '{albumArtist}/{album}/{disc}/{track} - {artist} - {title}' },
  'flat': { label: 'Flat: Artist - Album - NN - Title', template: '{albumArtist} - {album} - {track} - {title}' },
};

export interface OrganizeAction {
  candidateId: string;
  sourcePath: string;
  destRelPath: string;
  destPath: string;
  /** Corrected tags to stamp onto the COPY (baseline from reconstruction; overridable by enrichment). */
  tags: TrackTags;
}

export interface OrganizePlan {
  destRoot: string;
  actions: OrganizeAction[];
  collisions: Array<{ destRelPath: string; sources: string[] }>;
  skipped: Array<{ candidateId: string; reason: string }>;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Make a single path segment safe on Windows + POSIX. */
export function sanitizeSegment(s: string): string {
  let out = s
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ') // illegal chars
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '') // no trailing dot/space (Windows)
    .trim();
  if (RESERVED.test(out)) out = `_${out}`;
  if (out.length > 120) out = out.slice(0, 120).trim();
  return out || 'Unknown';
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

interface TemplateCtx {
  albumArtist: string;
  artist: string;
  album: string;
  year?: number;
  title: string;
  position: number;
  discNo: number;
}

/**
 * Render a template into sanitized path segments. Token values are sanitized individually (so they can't
 * inject path separators), literal template characters (like " - ") are preserved, empty segments drop out.
 */
function renderTemplate(tpl: string, ctx: TemplateCtx, multiDisc: boolean): string[] {
  const vals: Record<string, string> = {
    albumArtist: sanitizeSegment(ctx.albumArtist),
    artist: sanitizeSegment(ctx.artist || ctx.albumArtist),
    album: sanitizeSegment(ctx.album),
    title: sanitizeSegment(ctx.title || `Track ${ctx.position}`),
    year: ctx.year ? String(ctx.year) : '',
    disc: multiDisc ? `Disc ${ctx.discNo}` : '',
    track: pad2(ctx.position),
  };
  const rendered = tpl.replace(/\{(\w+)\}/g, (_, k: string) => (k in vals ? vals[k]! : ''));
  const segs = rendered.split('/').map((s) => s.replace(/\s{2,}/g, ' ').trim()).filter((s) => s.length > 0);
  // guarantee disc separation for multi-disc releases even if the template omits {disc}
  if (multiDisc && !tpl.includes('{disc}') && segs.length > 0) {
    const file = segs.pop()!;
    segs.push(`Disc ${ctx.discNo}`, file);
  }
  return segs;
}

type Tracklist = NonNullable<AlbumEnrichment['tracklist']>;

/** A normalized title key for aligning files to a tracklist; tolerant of "(Live)"/"[2007 Remaster]" suffixes. */
function matchKey(title: string): string {
  return normalize(title.replace(/[([{][^)\]}]*[)\]}]/g, ' '));
}

/** Faithful source order: by folder, then filename (numeric-aware) — the order the files actually play in. */
function sourceOrder(a: TrackSlot, b: TrackSlot): number {
  if (a.file.dir !== b.file.dir) return a.file.dir.localeCompare(b.file.dir);
  return a.file.name.localeCompare(b.file.name, undefined, { numeric: true });
}

/** True if two tracks share a (disc, position) slot — the cause of the destination collision. */
function hasDuplicateSlots(discs: DiscGroup[]): boolean {
  const seen = new Set<string>();
  for (const d of discs) {
    for (const t of d.tracks) {
      const k = `${d.discNo}:${t.position}`;
      if (seen.has(k)) return true;
      seen.add(k);
    }
  }
  return false;
}

const discSpan = (tl: Tracklist): number => new Set(tl.map((t) => t.disc)).size;

/** Rebuild DiscGroup[] from explicit (track, disc, position) assignments. */
function groupSlots(assigned: Array<{ slot: TrackSlot; discNo: number; position: number }>): DiscGroup[] {
  const byDisc = new Map<number, TrackSlot[]>();
  for (const { slot, discNo, position } of assigned) {
    if (!byDisc.has(discNo)) byDisc.set(discNo, []);
    byDisc.get(discNo)!.push({ ...slot, discNo, position });
  }
  return [...byDisc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([discNo, tracks]) => {
      tracks.sort((a, b) => a.position - b.position);
      const maxTrackNo = tracks.reduce((m, t) => Math.max(m, t.position), 0);
      return { discNo, sourceDirs: [...new Set(tracks.map((t) => t.file.dir))], tracks, maxTrackNo };
    });
}

/**
 * Align reconstructed tracks onto the authoritative MB tracklist (which carries the real disc/position).
 * Title match first (handles a single folder whose two discs interleave after a filename sort), then
 * fill leftovers in source order. Returns null if the counts don't line up (can't trust a 1:1 remap).
 */
function remapByTracklist(tracks: TrackSlot[], tl: Tracklist): DiscGroup[] | null {
  if (tl.length !== tracks.length) return null;
  const ordered = [...tracks].sort(sourceOrder);
  const used = new Array<boolean>(ordered.length).fill(false);
  const slotFor = new Array<TrackSlot | undefined>(tl.length);

  // pass 1: match each tracklist entry to a same-title file
  const byTitle = new Map<string, number[]>();
  ordered.forEach((t, i) => {
    const k = matchKey(t.title);
    if (!k) return;
    let bucket = byTitle.get(k);
    if (!bucket) byTitle.set(k, (bucket = []));
    bucket.push(i);
  });
  tl.forEach((e, ei) => {
    const bucket = byTitle.get(matchKey(e.title));
    while (bucket && bucket.length) {
      const i = bucket.shift()!;
      if (!used[i]) {
        slotFor[ei] = ordered[i];
        used[i] = true;
        break;
      }
    }
  });

  // pass 2: fill unmatched entries with the remaining files in source order
  let next = 0;
  for (let ei = 0; ei < tl.length; ei++) {
    if (slotFor[ei]) continue;
    while (next < ordered.length && used[next]) next++;
    slotFor[ei] = ordered[next];
    used[next] = true;
  }

  return groupSlots(tl.map((e, ei) => ({ slot: slotFor[ei]!, discNo: e.disc, position: e.position })));
}

/**
 * Split a collapsed single disc into discs by detecting track-number resets in source order
 * (a folder change, or a position that fails to advance, starts a new disc). The offline fallback
 * for when there's no authoritative tracklist to remap against.
 */
function splitByResets(tracks: TrackSlot[]): DiscGroup[] {
  const ordered = [...tracks].sort(sourceOrder);
  const assigned: Array<{ slot: TrackSlot; discNo: number; position: number }> = [];
  let discNo = 1;
  let prevPos = 0;
  let prevDir: string | undefined;
  let countInDisc = 0;
  for (const t of ordered) {
    const dirChanged = prevDir !== undefined && t.file.dir !== prevDir;
    if (countInDisc > 0 && (dirChanged || t.position <= prevPos)) {
      discNo++;
      countInDisc = 0;
    }
    assigned.push({ slot: t, discNo, position: t.position });
    countInDisc++;
    prevPos = t.position;
    prevDir = t.file.dir;
  }
  return groupSlots(assigned);
}

/**
 * Resolve the disc layout a candidate should actually be organized under. Most candidates pass through
 * unchanged; we only intervene when reconstruction collapsed a multi-disc release — detected as either
 * duplicate (disc, position) slots, or a single-disc candidate the enriched tracklist says is multi-disc.
 */
function resolveDiscs(c: AlbumCandidate, enr?: AlbumEnrichment): DiscGroup[] {
  const collapsed = hasDuplicateSlots(c.discs);
  const enrMulti = enr?.tracklist ? discSpan(enr.tracklist) > 1 : false;
  const reconSingle = c.discs.length <= 1;
  if (!collapsed && !(enrMulti && reconSingle)) return c.discs;

  const flat = c.discs.flatMap((d) => d.tracks);
  if (enr?.tracklist && enrMulti) {
    const remapped = remapByTracklist(flat, enr.tracklist);
    if (remapped) return remapped;
  }
  return collapsed ? splitByResets(flat) : c.discs;
}

export function planOrganize(candidates: AlbumCandidate[], opts: OrganizeOptions): OrganizePlan {
  const sep = opts.sep ?? '/';
  const minConf = opts.minConfidence ?? 0;
  const maxPathLength = opts.maxPathLength ?? 255;
  const template = opts.template ?? ORGANIZE_PRESETS['artist-year-album']!.template;
  const actions: OrganizeAction[] = [];
  const skipped: OrganizePlan['skipped'] = [];
  const destSeen = new Map<string, string[]>();

  for (const c of candidates) {
    if (c.confidence < minConf) {
      skipped.push({ candidateId: c.id, reason: `confidence ${c.confidence} < ${minConf}` });
      continue;
    }
    const enr = opts.enrichment?.get(c.id);
    const effArtist = enr?.artist ?? c.albumArtist;
    const effAlbum = enr?.album ?? c.albumTitle;
    const effYear = enr?.year ?? c.year;
    const effDiscs = resolveDiscs(c, enr);
    const discCount = effDiscs.length;
    const multiDisc = discCount > 1;

    for (const disc of effDiscs) {
      for (const t of disc.tracks) {
        const ext = extOf(t.file.name);
        const effTitle = enr?.trackTitles?.get(`${disc.discNo}:${t.position}`) ?? t.title;
        const segs = renderTemplate(template, { albumArtist: effArtist, artist: effArtist, album: effAlbum, ...(effYear != null ? { year: effYear } : {}), title: effTitle, position: t.position, discNo: disc.discNo }, multiDisc);
        if (segs.length === 0) {
          skipped.push({ candidateId: c.id, reason: 'template produced an empty path' });
          continue;
        }
        const fileSeg = segs.pop()! + (ext ? `.${ext}` : '');
        const destRelPath = [...segs, fileSeg].join(sep);
        const destPath = `${opts.destRoot}${sep}${destRelPath}`;
        if (destPath.length > maxPathLength) {
          skipped.push({ candidateId: c.id, reason: `destination path too long (${destPath.length} > ${maxPathLength} chars): ${destRelPath}` });
          continue;
        }
        const tags: TrackTags = {
          title: effTitle,
          album: effAlbum,
          albumArtist: effArtist,
          artist: effArtist,
          ...(effYear != null ? { year: effYear } : {}),
          trackNo: t.position,
          discNo: disc.discNo,
          discCount,
          ...(enr?.mbReleaseId ? { mbReleaseId: enr.mbReleaseId } : {}),
          ...(enr?.mbReleaseGroupId ? { mbReleaseGroupId: enr.mbReleaseGroupId } : {}),
        };
        actions.push({ candidateId: c.id, sourcePath: t.file.path, destRelPath, destPath, tags });
        if (!destSeen.has(destRelPath)) destSeen.set(destRelPath, []);
        destSeen.get(destRelPath)!.push(t.file.path);
      }
    }
  }

  const collisions = [...destSeen.entries()]
    .filter(([, srcs]) => srcs.length > 1)
    .map(([destRelPath, sources]) => ({ destRelPath, sources }));

  return { destRoot: opts.destRoot, actions, collisions, skipped };
}
