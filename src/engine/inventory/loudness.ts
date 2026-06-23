/**
 * Read embedded ReplayGain / R128 loudness tags from a real file via music-metadata.
 *
 * This is the OFFLINE, zero-dependency half of loudness normalization (I3): many rips already carry
 * REPLAYGAIN_TRACK_GAIN / R128 tags, so the player can level-match tracks with no decode and no network.
 * SOURCE MEDIA IS ONLY READ — nothing is written. Computing gain for untagged files (an ffmpeg ebur128
 * pass) is a separate, heavier layer; this reader is the cheap, instant-coverage path.
 */
import { parseFile } from 'music-metadata';

export interface ReplayGain {
  /** Track gain in dB to reach the tag's reference loudness (negative = attenuate a loud master). */
  trackGainDb: number | null;
  /** Album gain in dB — use for contiguous-album playback to preserve intra-album dynamics. */
  albumGainDb: number | null;
  /** Track sample peak as a linear ratio (~0..1); used to clamp positive gain so peaks never clip. */
  trackPeak: number | null;
  /** Album sample peak as a linear ratio. */
  albumPeak: number | null;
  /** Where the values came from: 'tag' if any value was present, else null (untagged file). */
  source: 'tag' | null;
}

/** music-metadata exposes gains/peaks as IRatio ({ dB, ratio }); typed defensively to survive version drift. */
interface RgCommon {
  replaygain_track_gain?: { dB?: number; ratio?: number } | null;
  replaygain_album_gain?: { dB?: number; ratio?: number } | null;
  replaygain_track_peak?: { dB?: number; ratio?: number } | null;
  replaygain_album_peak?: { dB?: number; ratio?: number } | null;
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const NONE: ReplayGain = { trackGainDb: null, albumGainDb: null, trackPeak: null, albumPeak: null, source: null };

/**
 * Read ReplayGain tags from a file. Returns all-null (source: null) for untagged or unreadable files —
 * the caller treats that as 0 dB (no normalization), so playback is unchanged when no tags exist.
 */
export async function readReplayGain(path: string): Promise<ReplayGain> {
  try {
    // We only need tags, not duration or covers — keep the parse cheap. skipPostHeaders mirrors readTags:
    // it avoids the trailing ID3v1 parse that throws on some corrupt files.
    const m = await parseFile(path, { duration: false, skipCovers: true, skipPostHeaders: true });
    const c = m.common as unknown as RgCommon;
    const trackGainDb = finite(c.replaygain_track_gain?.dB);
    const albumGainDb = finite(c.replaygain_album_gain?.dB);
    const trackPeak = finite(c.replaygain_track_peak?.ratio);
    const albumPeak = finite(c.replaygain_album_peak?.ratio);
    const has = trackGainDb != null || albumGainDb != null || trackPeak != null || albumPeak != null;
    return { trackGainDb, albumGainDb, trackPeak, albumPeak, source: has ? 'tag' : null };
  } catch {
    return NONE; // unreadable/corrupt — no normalization, identical to today
  }
}
