/**
 * Core domain types for the Media Sommelier engine.
 *
 * The engine is pure TypeScript with ZERO UI/Electron imports. Everything operates over plain
 * data records so the same logic runs from the CLI, from tests, and (later) from the desktop app.
 */

export type MediaType = 'music' | 'image' | 'video' | 'other';

/**
 * One file as discovered by an inventory source (filesystem walk OR a `dir /s` listing import).
 * This is the spine record — the analog of the `MediaFile` table in the plan's data model.
 */
export interface MediaFileRecord {
  /** Full path as reported by the source (Windows-style in the sample listing). */
  path: string;
  /** Containing directory path. */
  dir: string;
  /** Basename including extension. */
  name: string;
  /** Lowercased extension without the dot ('' if none). */
  ext: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** Modification time as ISO date string (YYYY-MM-DD granularity from listings). */
  mtime: string;
  mediaType: MediaType;
}

/** Result of parsing a single audio filename into its musical parts. */
export interface ParsedName {
  trackNo?: number;
  discNo?: number;
  artist?: string;
  title?: string;
  /** Which naming scheme matched, for diagnostics. */
  scheme: string;
  /** True if a track number was confidently extracted. */
  hasTrackNo: boolean;
}

/** One disc within a reconstructed release. */
export interface DiscGroup {
  discNo: number;
  /** Source folder(s) the disc's files came from. */
  sourceDirs: string[];
  tracks: TrackSlot[];
  /** Highest track number seen on this disc (basis for completeness). */
  maxTrackNo: number;
}

/** A file assigned to a position in a reconstructed release. */
export interface TrackSlot {
  file: MediaFileRecord;
  parsed: ParsedName;
  discNo: number;
  /** Inferred 1-based position within the disc. */
  position: number;
  title: string;
}

export type CandidateFlag =
  | 'no-track-numbers'
  | 'orphan'
  | 'partial-disc-set'
  | 'possible-compilation'
  | 'multi-folder-merge'
  | 'in-folder-multi-disc'
  | 'mixed-naming-schemes'
  | 'has-non-audio';

/**
 * A reconstructed album/release candidate — the offline analog of `AlbumCandidate` in the plan.
 * Confidence is OFFLINE-CAPPED (<= 0.75) by design: online fingerprint/MusicBrainz evidence is
 * what unlocks higher confidence and auto-accept.
 */
export interface AlbumCandidate {
  id: string;
  albumArtist: string;
  albumTitle: string;
  year?: number;
  discs: DiscGroup[];
  totalTracks: number;
  /** 0..1 estimate of tracklist completeness (tracks present / expected). */
  completeness: number;
  /** 0..0.75 offline confidence that this grouping is a real, coherent release. */
  confidence: number;
  flags: CandidateFlag[];
  /** Human-readable "why grouped" trace for the review UI. */
  evidence: string[];
  /** Naming schemes observed among the member files. */
  schemes: string[];
  sizeBytes: number;
}

/** A track title that appears in more than one candidate (verify by fingerprint later). */
export interface DuplicateCandidate {
  titleKey: string;
  occurrences: Array<{ candidateId: string; album: string; file: string; sizeBytes: number }>;
}

export interface ReconstructionReport {
  candidates: AlbumCandidate[];
  duplicates: DuplicateCandidate[];
  summary: {
    audioFiles: number;
    audioBytes: number;
    candidates: number;
    multiDisc: number;
    orphans: number;
    needsReview: number;
    losslessRatio: number;
    schemes: Record<string, number>;
  };
}
