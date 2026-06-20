/**
 * Read embedded tags + audio properties from a real file via music-metadata.
 * This is what makes a real Library view possible (artist/album/genre/duration/bitrate) and what
 * makes the stats accurate — the dir-listing import can't provide any of this.
 */
import { parseFile } from 'music-metadata';

export interface TagInfo {
  artist?: string;
  albumArtist?: string;
  album?: string;
  title?: string;
  genre?: string;
  year?: number;
  trackNo?: number;
  discNo?: number;
  durationMs?: number;
  bitrateKbps?: number;
  sampleRate?: number;
  lossless?: boolean;
}

export async function readTags(path: string): Promise<TagInfo> {
  try {
    const m = await parseFile(path, { duration: true });
    const c = m.common;
    const f = m.format;
    return {
      ...(c.artist ? { artist: c.artist } : {}),
      ...(c.albumartist ? { albumArtist: c.albumartist } : {}),
      ...(c.album ? { album: c.album } : {}),
      ...(c.title ? { title: c.title } : {}),
      ...(c.genre?.[0] ? { genre: c.genre[0] } : {}),
      ...(c.year != null ? { year: c.year } : {}),
      ...(c.track?.no != null ? { trackNo: c.track.no } : {}),
      ...(c.disk?.no != null ? { discNo: c.disk.no } : {}),
      ...(f.duration != null ? { durationMs: Math.round(f.duration * 1000) } : {}),
      ...(f.bitrate != null ? { bitrateKbps: Math.round(f.bitrate / 1000) } : {}),
      ...(f.sampleRate != null ? { sampleRate: f.sampleRate } : {}),
      ...(f.lossless != null ? { lossless: f.lossless } : {}),
    };
  } catch {
    return {}; // unreadable/corrupt — caller falls back to filename
  }
}
