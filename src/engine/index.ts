/** Public API of the Media Sommelier engine (pure TS, no UI/Electron imports). */
export type {
  MediaType,
  MediaFileRecord,
  ParsedName,
  DiscGroup,
  TrackSlot,
  CandidateFlag,
  AlbumCandidate,
  DuplicateCandidate,
  ReconstructionReport,
} from './types.js';

export { parseDirListing } from './inventory/dirListing.js';
export { walk, walkToArray, waitForPath } from './inventory/walk.js';
export type { WalkOptions, WaitOptions } from './inventory/walk.js';
export { readTags } from './inventory/tags.js';
export type { TagInfo } from './inventory/tags.js';
export { readCover } from './inventory/cover.js';
export type { Cover } from './inventory/cover.js';
export { readLyrics, parseLrc } from './inventory/lyrics.js';
export type { Lyrics, LyricLine } from './inventory/lyrics.js';
export { scanLibrary } from './library/scan.js';
export type { Track, ScanLibraryOptions } from './library/scan.js';
export { scanLibraryCached } from './library/catalog.js';
export type { CachedScanResult, CachedScanOptions } from './library/catalog.js';
export { computeLibraryStats } from './library/stats.js';
export type { LibraryStats } from './library/stats.js';
export { readPhoto, scanPhotos } from './library/photos.js';
export type { Photo, PhotoStats, PhotoScanResult } from './library/photos.js';
export { readVideo, scanVideos, computeVideoStats, resolutionBucket } from './library/videos.js';
export type { Video, VideoStats, VideoScanResult } from './library/videos.js';
export { parseName } from './reconstruct/parseName.js';
export { reconstruct } from './reconstruct/reconstruct.js';
export { planOrganize, sanitizeSegment, ORGANIZE_PRESETS } from './organize/plan.js';
export type { OrganizePlan, OrganizeAction, OrganizeOptions, AlbumEnrichment } from './organize/plan.js';
export { executePlan } from './organize/execute.js';
export type { ExecuteReport, ExecuteOptions, ActionResult } from './organize/execute.js';
export { writeTrackTags } from './organize/tag.js';
export type { TrackTags } from './organize/tag.js';
export { renderHtml } from './report/html.js';
export { computeInsights } from './insights/insights.js';
export type { InsightsReport, CollectionInsights, OwnerProfile, OwnerSignal } from './insights/insights.js';
export { MusicBrainzClient, extractTracklist } from './enrich/musicbrainz.js';
export type { MBRelease, MBReleaseDetail, MBTrack, MBMedium, MusicBrainzClientOptions } from './enrich/musicbrainz.js';
export { selectBestRelease, scoreRelease, artistCreditName } from './enrich/match.js';
export type { MatchResult } from './enrich/match.js';
export { enrichCandidate, enrichTop } from './enrich/enrich.js';
export type { EnrichedCandidate, EnrichOptions } from './enrich/enrich.js';
export { fingerprintFile, fpcalcPath, fpcalcAvailable } from './enrich/fpcalc.js';
export type { Fingerprint } from './enrich/fpcalc.js';
export { AcoustIdClient, parseLookupResponse } from './enrich/acoustid.js';
export type { AcoustIdResult, AcoustIdMatch } from './enrich/acoustid.js';
export {
  classifyGenre,
  isMood,
  isStyleFamily,
  STYLE_LABELS,
  MOOD_LABELS,
} from './dj/genreMood.js';
export type { StyleFamily, Mood, GenreClass } from './dj/genreMood.js';
export { autoDj } from './dj/autoDj.js';
export type { DjTrack, DjOptions, DjPick, DjSet } from './dj/autoDj.js';
export { humanBytes, normalize, titleKey, plausibleDurationMs } from './text.js';
