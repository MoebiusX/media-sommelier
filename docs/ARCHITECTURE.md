# Architecture

How the Media Sommelier engine is put together today (V0/V1), and the decisions behind it. For the
forward-looking plan see [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md); for the running build log
see [`../STATUS.md`](../STATUS.md).

## Shape

The whole thing is a **pure-TypeScript engine** plus a thin **CLI**. The engine has zero UI/Electron
imports, so the same logic runs from the CLI, from tests, and (later) from the desktop shell.

```
src/
  engine/
    types.ts                 # domain types (MediaFileRecord, AlbumCandidate, …)
    text.ts                  # normalization helpers (normalize, titleKey, stripDiscTokens, …)
    inventory/
      dirListing.ts          # parse a Windows `dir /s` dump → MediaFileRecord[]
      walk.ts                # real filesystem walker (retrying, skip-surfacing)
    reconstruct/
      parseName.ts           # filename → {disc, track, artist?, title?} across naming schemes
      reconstruct.ts         # the core: cluster files → AlbumCandidate[] (multi-disc aware)
    organize/
      plan.ts                # AlbumCandidate[] → OrganizePlan (dest paths + tags), collision detect
      execute.ts             # copy → verify → tag-the-copy → atomic publish (source read-only)
      tag.ts                 # write ID3/Vorbis/MP4 tags (node-taglib-sharp)
    enrich/
      musicbrainz.ts         # MB client (rate-limited, cached) + tracklist extraction
      acoustid.ts            # AcoustID lookup client + response parser
      fpcalc.ts              # Chromaprint fingerprint adapter (vendored fpcalc)
      match.ts               # pure release-matching scorer
      enrich.ts              # orchestration: MB-by-tags → AcoustID fallback → tracklist
    insights/insights.ts     # collection metrics + owner profiling (with honest gating)
    report/html.ts           # self-contained HTML report
    index.ts                 # public API barrel
  cli/index.ts               # commands: reconstruct, plan, organize, insights, enrich, fingerprint
```

## The pipeline

```
inventory ──▶ reconstruct ──▶ [enrich] ──▶ plan ──▶ execute
(walk OR     (cluster into    (MB/AcoustID  (dest    (copy → verify →
 dir-listing) AlbumCandidates) corrections)  paths    tag-the-copy →
                                            + tags)   atomic publish)
                              └─▶ insights (collection + owner profile)
```

- **Inventory** is pluggable: the real `walk()` for a mounted library, or `parseDirListing()` for a
  `dir /s` dump. Both emit the same `MediaFileRecord`, so reconstruction is exercised on real data
  (the committed sample) without needing the drive mounted.
- **Reconstruct** is the heart (see below). Output is `AlbumCandidate[]` with confidence + an
  evidence trace.
- **Enrich** (optional) corrects candidates against MusicBrainz, with AcoustID fingerprinting as a
  fallback. Produces canonical artist/album/year/MBIDs and per-track titles.
- **Plan** turns candidates (+ enrichment overrides) into an `OrganizePlan`: one `OrganizeAction` per
  file with a sanitized destination path and a `TrackTags` payload. Detects destination collisions.
- **Execute** performs the only writes in the system, all to the destination tree.

## Reconstruction (engine core)

Files are grouped by containing folder, each filename parsed for disc/track/artist/title. Three
multi-disc **merge strategies** rebuild releases split across folders:

1. **inline-marker stems** — siblings sharing a stem after stripping a disc token
   (`Pink Floyd - Echoes Cd 1` + `… Cd 2`).
2. **dedicated-parent prefix** — sibling folders under one container differing only by a trailing
   roman/number/volume token (`Greatest Hits I/II/III`, `…(volume1/2)`).
3. **in-folder disc prefixes** — one folder, disc encoded in the filename (`101-…`, `201-…`).

**Artist attribution** uses (in order): a consistent artist parsed from filenames → an `Artist - Album`
folder convention (after stripping a leading year/disc) → the folder *one level above* the album (the
`Artist/Album/` layout) → the leading token. This is what stops a leading year being read as the artist.

Each candidate gets an **offline-capped confidence (≤ 0.75)** and a human-readable "why grouped"
evidence list; duplicate titles across candidates and orphan/partial-disc cases are flagged.

## Enrichment strategy (hybrid, offline-graceful)

1. **MusicBrainz by tags** — search by artist + album; the pure `match.ts` scorer picks the best
   release (title/artist Dice + track-count proximity). No key, no file access needed.
2. **AcoustID fallback** — when tags don't match and files are readable: fingerprint a representative
   track (`fpcalc`) → AcoustID lookup → use the identified artist to **re-query MusicBrainz**. Rescues
   mistagged/mis-parsed artists.
3. **Tracklist** — fetch the matched release's authoritative tracklist for per-track titles.

Both clients are **rate-limited, on-disk cached, and send a descriptive User-Agent**; only successful
responses are cached (auth/transient errors never poison the cache). Everything degrades to "no-match"
on failure, leaving reconstructed values in place.

## Safety guarantees (and how they're enforced)

The product's #1 promise: **source files are never mutated.** Hardened after an adversarial review:

- The source is only ever **read** — `execute.ts` streams the source once (hashing during the copy)
  and never opens it for writing, renames it, or deletes it.
- **Destination must be outside the source tree** — `executePlan` refuses a dest equal to / inside /
  containing the source root.
- **No silent overwrites** — colliding destinations (two sources → one path) are *failed*, not
  overwritten; an existing destination is *skipped* (idempotent re-runs).
- **No torn files** — copy to a unique hidden temp (with the real extension so tagging works) →
  hash-verify against the source → `fsync` → tag the temp → **atomic rename**. A failed action cleans
  up its temp; a tag failure never fails the copy.
- **Path-length guard** keeps destinations under ~`MAX_PATH`.

## Key technology decisions

| Decision | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript on Node 22 (tsx + vitest) | one language end-to-end; engine stays UI-free |
| Tag read / write | music-metadata (read) / node-taglib-sharp (write) | streaming reads; one write API across formats, no native deps |
| Fingerprint | vendored `fpcalc` 1.5.1 (FFmpeg/**LGPL** build) | only mature Chromaprint; subprocess-isolated; license-safe |
| Hashing | sha256 streamed during copy | integrity without a second source read |
| Enrichment posture | MB-by-tags default; AcoustID fingerprint as fallback | the offline/tag path is the real default at scale |

## Testing

60 tests (`vitest`), all network/disk-free except two real-FS integration tests:

- pure logic: text helpers, `parseName`, reconstruction on the real sample, the match scorer, tracklist
  extraction, AcoustID response parsing, plan tags/enrichment overrides, path sanitization.
- **clients**: `MusicBrainzClient`/`AcoustIdClient` via an **injected `fetch`** — caching, offline,
  error-not-cached.
- **orchestration**: `enrichCandidate` via duck-typed fakes + an injected `fingerprintFn` — MB-tags
  match, AcoustID→MB fallback, no-match, tracklist, no-key.
- **real FS**: walk → reconstruct → plan → execute on synthetic files (hash-verified copies, source
  untouched, idempotent); collision/dest-disjoint guards.

## Current limitations (deferred, by design)

- No persistent catalog DB yet (SQLite is planned); reconstruction is in-memory per run.
- No Electron shell yet (CLI only).
- Reconstruction is heuristic; MusicBrainz/AcoustID provide the authoritative corrections.
- Confidence weights and match thresholds are hand-tuned, not yet corpus-calibrated.
- CUE/single-file album images are out of scope for v1 (would be quarantined, not split).
