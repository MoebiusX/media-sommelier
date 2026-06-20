/**
 * Collection insights + owner profiling (V0).
 *
 * Implements the plan's corrected posture: LEAD with signals that survive copying (formats, lossless
 * ratio, compilation density, completeness, release years) and GATE the acquisition timeline behind a
 * reliability check (a one-day bulk import collapses fs timestamps to fiction). Every owner inference
 * carries a confidence + plain-language "why". 100% local; nothing leaves the machine.
 */
import type { AlbumCandidate, MediaFileRecord, ReconstructionReport } from '../types.js';
import { isAudioExt, isLosslessExt } from '../text.js';

export interface CollectionInsights {
  releases: number;
  tracks: number;
  bytes: number;
  avgTrackMB: number;
  losslessRatio: number;
  formats: Record<string, number>;
  avgTracksPerRelease: number;
  multiDisc: number;
  orphans: number;
  compilationRatio: number;
  numberedReleaseRatio: number;
  knownYearRatio: number;
  decadeHistogram: Record<string, number>;
  topArtists: Array<{ artist: string; releases: number; tracks: number }>;
}

export interface OwnerSignal {
  label: string;
  confidence: number;
  why: string;
}

export interface OwnerProfile {
  buildHistory: { reliable: boolean; reason: string; byDate: Record<string, number> };
  classicVsNew: { computable: boolean; reason: string; classicPct?: number; cutoff: number };
  archetypes: OwnerSignal[];
  signals: OwnerSignal[];
}

export interface InsightsReport {
  collection: CollectionInsights;
  owner: OwnerProfile;
}

const CLASSIC_CUTOFF = 1995;

export function computeInsights(records: MediaFileRecord[], report: ReconstructionReport): InsightsReport {
  const audio = records.filter((r) => isAudioExt(r.ext));
  const { candidates } = report;

  // ---- collection ----
  const formats: Record<string, number> = {};
  const byDate: Record<string, number> = {};
  for (const a of audio) {
    formats[a.ext] = (formats[a.ext] ?? 0) + 1;
    byDate[a.mtime] = (byDate[a.mtime] ?? 0) + 1;
  }
  const tracks = candidates.reduce((n, c) => n + c.totalTracks, 0);
  const bytes = audio.reduce((n, a) => n + a.sizeBytes, 0);
  const lossless = audio.filter((a) => isLosslessExt(a.ext)).length;

  const artistMap = new Map<string, { releases: number; tracks: number }>();
  for (const c of candidates) {
    const e = artistMap.get(c.albumArtist) ?? { releases: 0, tracks: 0 };
    e.releases++;
    e.tracks += c.totalTracks;
    artistMap.set(c.albumArtist, e);
  }
  const topArtists = [...artistMap.entries()]
    .map(([artist, v]) => ({ artist, ...v }))
    .sort((a, b) => b.tracks - a.tracks)
    .slice(0, 10);

  const decadeHistogram: Record<string, number> = {};
  let knownYear = 0;
  for (const c of candidates) {
    if (c.year) {
      knownYear++;
      const d = `${Math.floor(c.year / 10) * 10}s`;
      decadeHistogram[d] = (decadeHistogram[d] ?? 0) + 1;
    }
  }

  const compilations = candidates.filter((c) => c.flags.includes('possible-compilation')).length;
  const numbered = candidates.filter((c) => !c.flags.includes('no-track-numbers')).length;

  const collection: CollectionInsights = {
    releases: candidates.length,
    tracks,
    bytes,
    avgTrackMB: audio.length ? bytes / audio.length / 1048576 : 0,
    losslessRatio: audio.length ? lossless / audio.length : 0,
    formats,
    avgTracksPerRelease: candidates.length ? tracks / candidates.length : 0,
    multiDisc: candidates.filter((c) => c.discs.length > 1).length,
    orphans: candidates.filter((c) => c.flags.includes('orphan')).length,
    compilationRatio: candidates.length ? compilations / candidates.length : 0,
    numberedReleaseRatio: candidates.length ? numbered / candidates.length : 0,
    knownYearRatio: candidates.length ? knownYear / candidates.length : 0,
    decadeHistogram,
    topArtists,
  };

  // ---- owner ----
  const owner = profileOwner(audio, candidates, byDate, knownYear);
  return { collection, owner };
}

function profileOwner(
  audio: MediaFileRecord[],
  candidates: AlbumCandidate[],
  byDate: Record<string, number>,
  knownYear: number,
): OwnerProfile {
  // build history reliability (single-import-day collapse detection)
  const dates = Object.entries(byDate).sort((a, b) => b[1] - a[1]);
  const topShare = audio.length && dates.length ? dates[0]![1] / audio.length : 0;
  const distinctDays = dates.length;
  const reliable = distinctDays >= 5 && topShare < 0.6;
  const buildHistory = {
    reliable,
    reason: reliable
      ? `${distinctDays} distinct acquisition days; spread looks genuine.`
      : `${Math.round(topShare * 100)}% of files share one date (${dates[0]?.[0] ?? 'n/a'}) — looks like a bulk copy/restore, so file timestamps don't reflect true acquisition. Timeline withheld.`,
    byDate,
  };

  // classic-vs-new (gated on having enough known years)
  const yearKnownRatio = candidates.length ? knownYear / candidates.length : 0;
  let classicVsNew: OwnerProfile['classicVsNew'];
  if (yearKnownRatio < 0.5) {
    classicVsNew = {
      computable: false,
      reason: `release year known for only ${Math.round(yearKnownRatio * 100)}% of releases — need tags/MusicBrainz (a V1 feature) to judge classic-vs-new.`,
      cutoff: CLASSIC_CUTOFF,
    };
  } else {
    const withYear = candidates.filter((c) => c.year);
    const classic = withYear.filter((c) => (c.year ?? 9999) < CLASSIC_CUTOFF).length;
    classicVsNew = {
      computable: true,
      reason: `${withYear.length} releases with a known year.`,
      classicPct: withYear.length ? classic / withYear.length : 0,
      cutoff: CLASSIC_CUTOFF,
    };
  }

  // archetypes (ranked, rule-based, with confidence + why)
  const archetypes: OwnerSignal[] = [];
  const compRatio = candidates.length ? candidates.filter((c) => c.flags.includes('possible-compilation')).length / candidates.length : 0;
  const losslessRatio = audio.length ? audio.filter((a) => isLosslessExt(a.ext)).length / audio.length : 0;
  const orphanRatio = candidates.length ? candidates.filter((c) => c.flags.includes('orphan')).length / candidates.length : 0;

  if (compRatio >= 0.4) {
    archetypes.push({
      label: 'Curated / casual listener (greatest-hits driven)',
      confidence: Math.min(0.85, 0.5 + compRatio / 2),
      why: `${Math.round(compRatio * 100)}% of releases are best-of/greatest-hits/compilations — favors known hits over deep album cuts.`,
    });
  }
  if (losslessRatio < 0.05) {
    archetypes.push({
      label: 'Convenience over fidelity',
      confidence: 0.8,
      why: `${Math.round(losslessRatio * 100)}% lossless — an entirely lossy (MP3) library, not an audiophile archive.`,
    });
  } else if (losslessRatio > 0.6) {
    archetypes.push({ label: 'Audiophile / fidelity-focused', confidence: 0.7, why: `${Math.round(losslessRatio * 100)}% lossless.` });
  }
  if (orphanRatio >= 0.2) {
    archetypes.push({
      label: 'Sampler, not a completionist',
      confidence: 0.6,
      why: `${Math.round(orphanRatio * 100)}% of "albums" are a single track — whole records reduced to their one famous song.`,
    });
  }
  archetypes.sort((a, b) => b.confidence - a.confidence);

  // supporting signals
  const signals: OwnerSignal[] = [];
  const avgMB = audio.length ? audio.reduce((n, a) => n + a.sizeBytes, 0) / audio.length / 1048576 : 0;
  signals.push({
    label: `~${Math.round((avgMB * 1048576 * 8) / 240 / 1000)} kbps average MP3`,
    confidence: 0.4,
    why: `avg track ${avgMB.toFixed(1)} MB assuming ~4 min/track — header read needed to confirm exact bitrate.`,
  });
  if (!buildHistory.reliable) {
    signals.push({
      label: 'Library bulk-imported, not gradually collected',
      confidence: 0.65,
      why: buildHistory.reason,
    });
  }
  return { buildHistory, classicVsNew, archetypes, signals };
}
