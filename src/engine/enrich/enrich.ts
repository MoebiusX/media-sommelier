/**
 * Enrichment orchestration — turns a reconstructed candidate into an enriched one.
 *
 * Strategy (offline-graceful, hybrid):
 *   1. MusicBrainz search by existing tags (artist + album)         — no key, no file access.
 *   2. If no confident match AND fingerprinting is enabled: fingerprint a representative track →
 *      AcoustID → use the identified ARTIST to retry the MusicBrainz search (rescues mis-parsed
 *      artists like "Jefferson"/"U2-The"). Requires the AcoustID application key + readable files.
 *   3. Optionally fetch the matched release's authoritative TRACKLIST (per-track titles).
 *
 * Adds the release YEAR (→ classic-vs-new) and stable MBIDs (provenance). Any failure degrades to
 * 'no-match' and the reconstructed values stand — callers never branch on connectivity.
 */
import type { AlbumCandidate, ReconstructionReport } from '../types.js';
import type { MusicBrainzClient } from './musicbrainz.js';
import type { AcoustIdClient } from './acoustid.js';
import { artistCreditName, selectBestRelease } from './match.js';
import { extractTracklist } from './musicbrainz.js';
import { fingerprintFile } from './fpcalc.js';

export interface EnrichOptions {
  mb: MusicBrainzClient;
  acoustid?: AcoustIdClient;
  /** Fingerprint a representative track to recover mis-tagged albums (needs AcoustID key + files). */
  fingerprintFallback?: boolean;
  /** Fetch the matched release's full tracklist (one extra MB call per matched album). */
  fetchTracklist?: boolean;
}

export interface EnrichedCandidate {
  id: string;
  before: { artist: string; album: string; year?: number; tracks: number };
  status: 'matched' | 'no-match';
  via?: 'mb-tags' | 'acoustid+mb';
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
    tracklist?: Array<{ disc: number; position: number; title: string }>;
  };
}

function yearOf(date?: string): number | undefined {
  const m = date?.match(/^(\d{4})/);
  return m ? Number(m[1]) : undefined;
}

function sampleFile(c: AlbumCandidate): string | undefined {
  return c.discs[0]?.tracks[0]?.file.path;
}

export async function enrichCandidate(candidate: AlbumCandidate, opts: EnrichOptions): Promise<EnrichedCandidate> {
  const before = {
    artist: candidate.albumArtist,
    album: candidate.albumTitle,
    ...(candidate.year != null ? { year: candidate.year } : {}),
    tracks: candidate.totalTracks,
  };

  // 1) MusicBrainz by existing tags
  let best = selectBestRelease(candidate, await opts.mb.searchReleases(candidate.albumArtist, candidate.albumTitle));
  let via: EnrichedCandidate['via'] = 'mb-tags';

  // 2) AcoustID fingerprint fallback to recover the real artist, then retry MB
  if (!best && opts.fingerprintFallback && opts.acoustid?.hasKey()) {
    const file = sampleFile(candidate);
    if (file) {
      try {
        const fp = await fingerprintFile(file);
        const ar = await opts.acoustid.lookup(fp);
        if (ar.best?.artist) {
          const retry = await opts.mb.searchReleases(ar.best.artist, candidate.albumTitle);
          best = selectBestRelease({ ...candidate, albumArtist: ar.best.artist }, retry);
          if (best) via = 'acoustid+mb';
        }
      } catch {
        /* fingerprint/lookup failed (offline, drive gone, decode error) — stay no-match */
      }
    }
  }

  if (!best) return { id: candidate.id, before, status: 'no-match' };

  const r = best.release;
  const year = yearOf(r.date);
  let tracklist: Array<{ disc: number; position: number; title: string }> | undefined;
  if (opts.fetchTracklist) {
    tracklist = extractTracklist(await opts.mb.getRelease(r.id));
  }

  return {
    id: candidate.id,
    before,
    status: 'matched',
    via,
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
      ...(tracklist && tracklist.length ? { tracklist } : {}),
    },
  };
}

/** Enrich the top-N candidates (by track count) sequentially (the clients throttle network calls). */
export async function enrichTop(report: ReconstructionReport, opts: EnrichOptions, limit = 6): Promise<EnrichedCandidate[]> {
  const targets = [...report.candidates].sort((a, b) => b.totalTracks - a.totalTracks).slice(0, limit);
  const out: EnrichedCandidate[] = [];
  for (const c of targets) out.push(await enrichCandidate(c, opts));
  return out;
}
