/**
 * Video scan via ffprobe — the moving-picture half of the library, mirroring photos.ts.
 *
 * Probes container/stream metadata (duration, resolution, codecs, bitrate, fps) with the prebuilt
 * `ffprobe-static` binary in an isolated subprocess. ffprobe only READS the source file; it never
 * mutates it (guarantee #1). Probing is heavier than EXIF, so the scan pool is smaller (concurrency
 * ~4). Any failure (missing binary, unprobeable file) degrades to {} rather than crashing the scan.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import type { MediaFileRecord } from '../types.js';
import { walkToArray } from '../inventory/walk.js';

const execFileAsync = promisify(execFile);

/** Resolve the ffprobe binary: FFPROBE_PATH env → bundled ffprobe-static → bare name on PATH. */
function ffprobePath(): string {
  const exe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  if (process.env.FFPROBE_PATH && existsSync(process.env.FFPROBE_PATH)) return process.env.FFPROBE_PATH;
  try {
    const require = createRequire(import.meta.url);
    const mod = require('ffprobe-static') as { path?: string };
    if (mod.path && existsSync(mod.path)) return mod.path;
  } catch {
    // fall through to PATH lookup
  }
  return exe;
}

export interface Video extends MediaFileRecord {
  /** Basename without extension. */
  title: string;
  durationMs?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  /** Container/format short name (e.g. "matroska,webm", "mov,mp4,m4a,3gp,3g2,mj2"). */
  container?: string;
  bitrateKbps?: number;
  fps?: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}
interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  bit_rate?: string;
}
interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

function parseFps(rate?: string): number | undefined {
  if (!rate) return undefined;
  const [n, d] = rate.split('/');
  const num = Number(n);
  const den = d == null ? 1 : Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return undefined;
  const fps = num / den;
  return fps > 0 ? Math.round(fps * 100) / 100 : undefined;
}

export async function readVideo(path: string, timeoutMs = 30_000): Promise<Partial<Video>> {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath(),
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    );
    const j = JSON.parse(stdout) as FfprobeOutput;
    const streams = j.streams ?? [];
    const v = streams.find((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    const fmt = j.format ?? {};

    const durationSec = fmt.duration != null ? Number(fmt.duration) : NaN;
    const bitrate = fmt.bit_rate != null ? Number(fmt.bit_rate) : NaN;
    const fps = parseFps(v?.avg_frame_rate) ?? parseFps(v?.r_frame_rate);

    return {
      ...(Number.isFinite(durationSec) && durationSec > 0 ? { durationMs: Math.round(durationSec * 1000) } : {}),
      ...(v?.width ? { width: v.width } : {}),
      ...(v?.height ? { height: v.height } : {}),
      ...(v?.codec_name ? { videoCodec: v.codec_name } : {}),
      ...(a?.codec_name ? { audioCodec: a.codec_name } : {}),
      ...(fmt.format_name ? { container: fmt.format_name } : {}),
      ...(Number.isFinite(bitrate) && bitrate > 0 ? { bitrateKbps: Math.round(bitrate / 1000) } : {}),
      ...(fps != null ? { fps } : {}),
    };
  } catch {
    return {};
  }
}

export interface VideoStats {
  count: number;
  bytes: number;
  totalDurationMs: number;
  /** Resolution buckets ("4K"/"1080p"/"720p"/"480p"/"SD"/"unknown") → count. */
  resolutions: Record<string, number>;
  /** Container short-name → count. */
  containers: Record<string, number>;
  /** A few longest videos, descending by duration. */
  longest: Array<{ title: string; path: string; durationMs: number }>;
}

export interface VideoScanResult {
  videos: Video[];
  stats: VideoStats;
}

/**
 * Bucket a video by its vertical resolution (height), the conventional naming axis. Height is the
 * primary signal; width is used only as a fallback when height is missing, so a short-but-wide
 * letterboxed/anamorphic source isn't over-promoted purely on its pixel width.
 */
export function resolutionBucket(v: Pick<Video, 'width' | 'height'>): string {
  const h = v.height ?? 0;
  const w = v.width ?? 0;
  if (!h && !w) return 'unknown';
  const axis = h || w; // prefer height; fall back to width only when height is absent
  if (axis >= 2160) return '4K';
  if (axis >= 1080) return '1080p';
  if (axis >= 720) return '720p';
  if (axis >= 480) return '480p';
  return 'SD';
}

function titleOf(rec: MediaFileRecord): string {
  const base = basename(rec.name);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export async function scanVideos(
  root: string,
  opts: { limit?: number; concurrency?: number } = {},
): Promise<VideoScanResult> {
  const records = await walkToArray(root, { include: ['video'], ...(opts.limit ? { limit: opts.limit } : {}) });
  const videos = new Array<Video>(records.length);
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < records.length) {
      const i = idx++;
      const rec = records[i]!;
      videos[i] = { ...rec, title: titleOf(rec), ...(await readVideo(rec.path)) };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, opts.concurrency ?? 4), records.length || 1) }, worker),
  );
  return { videos, stats: computeVideoStats(videos) };
}

export function computeVideoStats(videos: Video[]): VideoStats {
  const resolutions: Record<string, number> = {};
  const containers: Record<string, number> = {};
  let bytes = 0;
  let totalDurationMs = 0;
  for (const v of videos) {
    bytes += v.sizeBytes;
    if (v.durationMs) totalDurationMs += v.durationMs;
    const bucket = resolutionBucket(v);
    resolutions[bucket] = (resolutions[bucket] ?? 0) + 1;
    if (v.container) containers[v.container] = (containers[v.container] ?? 0) + 1;
  }
  const longest = videos
    .filter((v) => v.durationMs)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, 5)
    .map((v) => ({ title: v.title, path: v.path, durationMs: v.durationMs! }));
  return { count: videos.length, bytes, totalDurationMs, resolutions, containers, longest };
}
