/**
 * Tag writer — stamps corrected metadata onto a file using node-taglib-sharp (pure TS, no native deps,
 * one API across ID3/Vorbis/MP4). Used ONLY on destination copies in the organize flow; never on source.
 */
import { File } from 'node-taglib-sharp';

export interface TrackTags {
  title?: string;
  album?: string;
  artist?: string; // track performer
  albumArtist?: string;
  year?: number;
  trackNo?: number;
  trackCount?: number;
  discNo?: number;
  discCount?: number;
  mbReleaseId?: string;
  mbReleaseGroupId?: string;
}

/** Write the provided tags into `path` (in place — caller must point this at a COPY, not the source). */
export function writeTrackTags(path: string, tags: TrackTags): void {
  const f = File.createFromPath(path);
  try {
    const t = f.tag;
    if (tags.title != null) t.title = tags.title;
    if (tags.album != null) t.album = tags.album;
    if (tags.artist != null) t.performers = [tags.artist];
    if (tags.albumArtist != null) t.albumArtists = [tags.albumArtist];
    if (tags.year != null) t.year = tags.year;
    if (tags.trackNo != null) t.track = tags.trackNo;
    if (tags.trackCount != null) t.trackCount = tags.trackCount;
    if (tags.discNo != null) t.disc = tags.discNo;
    if (tags.discCount != null) t.discCount = tags.discCount;
    if (tags.mbReleaseId != null) t.musicBrainzReleaseId = tags.mbReleaseId;
    if (tags.mbReleaseGroupId != null) t.musicBrainzReleaseGroupId = tags.mbReleaseGroupId;
    f.save();
  } finally {
    f.dispose();
  }
}
