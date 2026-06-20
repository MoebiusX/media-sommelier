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
export { walk, walkToArray } from './inventory/walk.js';
export type { WalkOptions } from './inventory/walk.js';
export { parseName } from './reconstruct/parseName.js';
export { reconstruct } from './reconstruct/reconstruct.js';
export { planOrganize, sanitizeSegment } from './organize/plan.js';
export type { OrganizePlan, OrganizeAction, OrganizeOptions } from './organize/plan.js';
export { executePlan } from './organize/execute.js';
export type { ExecuteReport, ExecuteOptions, ActionResult } from './organize/execute.js';
export { writeTrackTags } from './organize/tag.js';
export type { TrackTags } from './organize/tag.js';
export { renderHtml } from './report/html.js';
export { computeInsights } from './insights/insights.js';
export type { InsightsReport, CollectionInsights, OwnerProfile, OwnerSignal } from './insights/insights.js';
export { MusicBrainzClient } from './enrich/musicbrainz.js';
export type { MBRelease, MusicBrainzClientOptions } from './enrich/musicbrainz.js';
export { selectBestRelease, scoreRelease, artistCreditName } from './enrich/match.js';
export type { MatchResult } from './enrich/match.js';
export { enrichCandidate, enrichTop } from './enrich/enrich.js';
export type { EnrichedCandidate } from './enrich/enrich.js';
export { fingerprintFile, fpcalcPath, fpcalcAvailable } from './enrich/fpcalc.js';
export type { Fingerprint } from './enrich/fpcalc.js';
export { AcoustIdClient, parseLookupResponse } from './enrich/acoustid.js';
export type { AcoustIdResult, AcoustIdMatch } from './enrich/acoustid.js';
export { humanBytes, normalize, titleKey } from './text.js';
