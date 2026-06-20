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
export { humanBytes, normalize, titleKey } from './text.js';
