/**
 * Enrichment orchestration — turns a reconstructed candidate into an enriched one by matching it to a
 * MusicBrainz release. This is the V1 step that authoritatively corrects album/artist/title and adds
 * the release YEAR (which unlocks classic-vs-new owner profiling) and stable MBIDs (provenance).
 *
 * Offline-graceful: with an offline client (or no match) it returns status 'no-match' and the original
 * fields stand — the UI/insights never branch on connectivity.
 */
import type { AlbumCandidate, ReconstructionReport } from '../types.js';
import type { MusicBrainzClient } from './musicbrainz.js';
import { artistCreditName, selectBestRelease } from './match.js';

export interface EnrichedCandidate {
  id: string;
  before: { artist: string; album: string; year?: number; tracks: number };
  status: 'matched' | 'no-match';
  match?: {
    mbid: string;
    releaseGroupMbid?: string;
    artist: string;
    album: string;
    year?: number;
    trackCount?: number;
    primaryType?: string;
    score: number;
    source: 'musicbrainz';
  };
}

function yearOf(date?: string): number | undefined {
  const m = date?.match(/^(\d{4})/);
  return m ? Number(m[1]) : undefined;
}

export async function enrichCandidate(candidate: AlbumCandidate, client: MusicBrainzClient): Promise<EnrichedCandidate> {
  const before = {
    artist: candidate.albumArtist,
    album: candidate.albumTitle,
    ...(candidate.year != null ? { year: candidate.year } : {}),
    tracks: candidate.totalTracks,
  };
  const releases = await client.searchReleases(candidate.albumArtist, candidate.albumTitle);
  const best = selectBestRelease(candidate, releases);
  if (!best) return { id: candidate.id, before, status: 'no-match' };

  const r = best.release;
  const year = yearOf(r.date);
  return {
    id: candidate.id,
    before,
    status: 'matched',
    match: {
      mbid: r.id,
      ...(r['release-group']?.id ? { releaseGroupMbid: r['release-group'].id } : {}),
      artist: artistCreditName(r) || candidate.albumArtist,
      album: r.title,
      ...(year != null ? { year } : {}),
      ...(r['track-count'] != null ? { trackCount: r['track-count'] } : {}),
      ...(r['release-group']?.['primary-type'] ? { primaryType: r['release-group']['primary-type'] } : {}),
      score: Math.round(best.score * 100) / 100,
      source: 'musicbrainz',
    },
  };
}

/** Enrich the top-N candidates (by track count) sequentially (the client throttles network calls). */
export async function enrichTop(report: ReconstructionReport, client: MusicBrainzClient, limit = 6): Promise<EnrichedCandidate[]> {
  const targets = [...report.candidates].sort((a, b) => b.totalTracks - a.totalTracks).slice(0, limit);
  const out: EnrichedCandidate[] = [];
  for (const c of targets) out.push(await enrichCandidate(c, client));
  return out;
}
