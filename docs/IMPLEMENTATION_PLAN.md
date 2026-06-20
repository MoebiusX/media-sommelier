# Media Sommelier — Implementation Plan

> Derived from a 15-agent design pass (10 facet designs → architecture synthesis → 4-lens
> adversarial review: completeness, scale, legal/ToS, sequencing). This document is the
> **review-corrected** plan — the synthesis tempered by what the critics found. The raw,
> uncut design output is preserved in [`design/DESIGN_PASS.md`](design/DESIGN_PASS.md).
>
> Companion docs: [`../README.md`](../README.md) (vision) · [`SAMPLE_SCAN.md`](SAMPLE_SCAN.md)
> (the real-world problem, measured on `Y:\Car Playlists\Selection`).

---

## 1. The promise

Take a scattered, mistagged, duplicated personal media collection and **reconstruct the real units it
should be** — albums for music, events for photos, series/events for video — then **copy** corrected,
well-tagged files into a clean tree (`Artist/Album/NN - Track`). Originals are **never mutated**. After a
scan, surface insight about the *collection* (genres, format/lossless mix, quality, duplicates,
completeness) and about the *owner* (taste, eras, classic-vs-new, collector archetype).

The core technical bet: album reconstruction is an **entity-resolution** problem. Don't match tracks
greedily; pick the *release best covered by a cluster of files* (constrained set-cover), so albums stay
intact across reissues and compilations.

## 2. The problem, proven on your real data

Every failure mode the engine must handle already appears in one slice of your drive (146 tracks, 1.3 GB,
0% lossless — see [`SAMPLE_SCAN.md`](SAMPLE_SCAN.md)). These are now the project's first regression fixtures:

| Real example (Y:\Car Playlists\Selection) | Failure mode | What the engine must do |
|---|---|---|
| `Pink Floyd - Echoes Cd 1` + `Echoes Cd 2` as two **sibling top-level folders** | Split multi-disc release | Re-merge sibling disc folders into one 2-disc release **before** scoring (multi-disc set-cover) |
| `Led Zeppelin …\…(Remasters 2CD)\CD 1`,`CD 2` (correct nesting) vs Pink Floyd (broken) | Disc nesting ambiguity | Detect disc folders whether nested under an album or flattened as siblings |
| `Supertramp - Very Best of (volume1/2)` — **0% track numbers** | Lost sequence | Infer order from fingerprint→MusicBrainz tracklist; offline, fall back to tag/filename |
| `Marc Antoine\Mediterraneo` = 1 file; `The Eagles\Top 100` = 1 file | Orphaned/stripped album | Flag as orphan; fingerprint to recover the true release it came from |
| `Bohemian Rapsody`, `Under Presure` vs `Under Pressure`, `I Want To Be Free` (→ *Break Free*) | Typo'd / wrong titles | **Fingerprint, not string-match** — this is the proof that tag-only matching fails |
| Queen Platinum: `Somebody To Love`, `Under Pressure`, `Another One Bites The Dust` on 2 discs | Cross-disc duplicates | Dedup **after** release assignment (a recording can legitimately sit on 2 releases) |
| 5 different naming schemes in one tree (`101-led_zeppelin-…`, `Pink Floyd - (05)Echoes`, …) | Naming entropy | Normalize per-scheme; never trust a single filename convention |
| Nearly every file stamped `2024-10-30` (one bulk copy) | Build-history is fiction | mtime = *copy* date, not acquisition. Owner timeline must gate on timestamp reliability |

This is why the plan leads with **dogfooding on this collection**, not synthetic fixtures.

## 3. Decisions

### Locked (from you)
| Decision | Choice |
|---|---|
| Form factor | Desktop app, modern TypeScript |
| File safety | **Copy to a new tree; source is read-only** |
| Enrichment | Hybrid: audio fingerprint + online DBs + offline fallback |
| Scale | Hundreds of thousands → 1M+ |
| Media | Music first, then images, then video |

### Resolved by the design pass
- **Electron, not Tauri.** Every heavy workload (better-sqlite3 bulk writes, sharp/libvips,
  `worker_threads`, `fpcalc`/`ffprobe` subprocesses, MusicBrainz HTTP) is Node-native. Tauri would still
  ship a Node sidecar — paying Rust+Node packaging cost for zero compute win. One language across UI,
  main, engine, and CLI. Engine isolation (the legit reason to want a "sidecar") is achieved with an
  Electron **`utilityProcess`** (own PID, survives renderer reloads).
- **SQLite is the system of record *and* the work queue.** One row per file with per-stage status
  columns → free crash recovery, idempotent resume, delta re-scans. (DuckDB only later, only if SQLite
  aggregation actually proves too slow — see §7.)

### ⚠ Must be decided NOW — it gates the whole licensing posture
**Is Media Sommelier ever going to be commercial (sold, subscription, paid bundle)?** The review found
this forks the architecture:
- **MusicBrainz** genres/tags/Live-Data-Feed are **CC BY-NC-SA**, *not* CC0 → attribution required +
  **NonCommercial** restriction.
- **AcoustID** (the irreducible fingerprint→ID service) is **free for non-commercial only**; commercial
  needs an AcoustID OÜ license, and it has **no offline substitute**.
- **Discogs** ToS **forbids** the durable offline caching this app is built around (no display >6h stale,
  no long-term storage).

→ See [§10 Licensing](#10-licensing--tos-the-landmines). **Recommended default: ship non-commercial /
personal-use**, which makes all three constraints satisfiable. If commercial is on the table, that must be
budgeted (AcoustID license, CC0-only field segregation) before architecture lock.

## 4. Architecture

Single language (TypeScript) end-to-end on **Electron 33+**. Three tiers + pure engine library:

```
flowchart TB
  subgraph Renderer["Renderer (React, sandboxed, NO Node)"]
    UI["Scan / Review Queue / Insights / Organize"]
    RM["Read model (TanStack Query+Virtual, windowed)"]
  end
  subgraph Main["Main process (Coordinator)"]
    LIFE["Lifecycle / menus / dialogs / safeStorage / auto-update"]
    IPC["Typed IPC (zod + credit-based progress stream)"]
  end
  subgraph Engine["Engine host (utilityProcess, own PID)"]
    SCHED["Resumable job scheduler (per-stage caps + backpressure)"]
    DB[("SQLite: catalog + queue + claims + FTS5 (WAL)")]
    ENGLIB["@sommelier/engine (pure TS): walk · reconstruct(set-cover) · enrich · organize · insights"]
  end
  subgraph Pools["Worker & subprocess pools"]
    PISCINA["Piscina worker_threads: tag parse · xxhash3 · pHash/dHash · FFT"]
    SUBP["execa pools: fpcalc(Chromaprint) · ffprobe/ffmpeg"]
  end
  EXT["External (rate-limited, cached): AcoustID · MusicBrainz · Cover Art Archive · Discogs"]
  SRC[("Source tree (READ-ONLY)")]
  DST[("Destination tree (COPY: Artist/Album/NN - Track)")]

  UI<-->RM<-->IPC<-->SCHED
  LIFE---IPC
  SCHED-->ENGLIB-->DB
  ENGLIB-->PISCINA & SUBP & EXT
  SUBP-->SRC
  ENGLIB-.read.->SRC
  ENGLIB-->|copy+verify+tag the COPY|DST
  CLI["@sommelier/cli"]-->ENGLIB
```

**Recommended stack**

| Layer | Choice |
|---|---|
| Shell / process model | Electron 33+, `contextIsolation`+`sandbox` on, engine in `utilityProcess` |
| UI | React 19 + TS 5.6 strict + Vite 6 (electron-vite); Tailwind + Radix/shadcn; TanStack Virtual/Table/Query + zustand; ECharts; dnd-kit; cmdk |
| OLTP store | SQLite via **better-sqlite3** (WAL, FTS5) + Drizzle migrations — engine-process only |
| Concurrency | **Piscina** `worker_threads` (CPU) + **execa**+p-queue per-binary subprocess pools; single SQLite writer, batched txns |
| Fingerprint | bundled per-OS/arch **fpcalc** (Chromaprint) via subprocess |
| Tag read / write | **music-metadata** (streaming read) / **node-taglib-sharp** (write to the copy) |
| Hashing | **xxhash3** (dedup gate) + **blake3** streaming-during-copy (integrity) |
| Image/video | **sharp** (libvips) pHash/dHash + thumbs; **exiftool-vendored**; **ffprobe/ffmpeg-static** (LGPL) |
| HTTP/enrichment | **undici** + bottleneck token buckets; content-addressed SQLite cache + single-flight + negative cache; p-retry + circuit breaker |
| Secrets | API keys via Electron **safeStorage** (OS keychain), never bundled |
| Monorepo | pnpm + Turborepo; `packages/{engine,ipc,cli,native-binaries}` + `apps/desktop`; tsup |
| Packaging | electron-builder + electron-updater (delta), sign/notarize; native binaries `asarUnpacked` + CI matrix + **packaged smoke test gates every release** |

> **Native-dependency discipline is the #1 engineering risk.** Every native engine (better-sqlite3,
> sharp, fpcalc, ffmpeg, exiftool, xxhash) × Win/mac/Linux × x64/arm64 × Electron ABI is a packaging
> tax. Prefer WASM where viable (hash-wasm), gate exiftool to the image/video phase, and **do not add
> DuckDB** unless SQLite aggregation is measured to be the bottleneck.

## 5. Data model (essentials)

One polymorphic **`MediaFile`** spine (id, path, mediaType, dev+ino, contentHash, per-stage states,
timestamps, soft-delete) with `TrackFile`/`PhotoFile`/`VideoFile` detail rows. Music entities mirror
MusicBrainz: `Artist`/`ArtistCredit` · `ReleaseGroup`→`Release`→`Medium`→`Track` · `Recording`
(the performance, shared across releases). Reconstruction state:

- **`AlbumCandidate`** + **`CandidateMember`** + immutable **`GroupingDecision`** log → the
  candidate → reviewed → confirmed FSM (human decisions never clobbered by re-scans).
- **`EvidenceTrace`** → powers the "why grouped" explainer in the review UI.
- **`Grouping`/`GroupMembership`** → confirmed units; the *only* thing that feeds organize.
- **`OrganizePlan`/`OrganizeAction`** → idempotent, resumable copy journal (idempotencyKey =
  plan+source+dest; sourceHash/copyHash/finalHash).
- **`Acquisition`** → fused acquisition estimate snapshotted *at scan, before organize resets fs times*.
- **`ExternalId`** (mbid/discogs/acoustid/isrc/barcode) + a **per-source `license` column** on metadata
  (added per the legal review — see §10).

> **Deferred to when online enrichment exists (not v0):** the append-only `MetadataClaim` +
> materialized `ResolvedField` provenance/EAV system. It's the right eventual design, but it adds no
> value until *multiple sources compete to overwrite each other*. v0 stores resolved metadata as plain
> columns + a `source` enum.

## 6. The reconstruction engine (the heart) — with review fixes baked in

**Pipeline:** `discover → stat → probe/tag → content-hash → [block → fingerprint → re-block] → release match → assign → dedup → candidate`.

1. **Blocking (candidate generation), iterative.** Avoid O(n²) via multi-key blocking + union-find. The
   review caught two real bugs, now fixed:
   - **Independent-signal corroboration.** Require ≥2 agreeing keys *from independent families*
     (folder cohesion / fingerprint cluster / embedded-cover hash / MBID) — **never two views of the
     same album tag**, which would over-merge greatest-hits/self-titled/"Live"/sentinel-tagged files.
     Any album value shared by >K distinct album-artists is auto-demoted to a non-merge key.
   - **Two-phase block → fingerprint → re-block loop.** Offline weak-key blocking makes *provisional*
     clusters; fingerprint only the **ambiguous/low-cohesion** ones; **re-block** on the new
     AcoustID/recording keys. (The strong keys only *exist* after fingerprinting — a one-shot block
     can't use them.) Cluster identity is preserved across re-blocking so review decisions survive.
2. **Release match = constrained set-cover, multi-disc-aware.** For a cluster, pick the MusicBrainz
   **Release best covered** by its recordings — but score coverage over **`(mediumPosition, trackPosition)`
   tuples**, allow a cluster to match a **subset of media** (a `CD 2`-only folder → "Release X, Disc 2,
   complete" not "50% incomplete"), and **re-merge sibling disc folders** via shared releaseGroup/barcode
   *before* final scoring. (This is exactly your Pink Floyd Echoes case.)
3. **Offline fallback produces the *same* candidate shape.** Cluster on
   `(albumArtist, album, year) + folder cohesion`, infer track order from tag/filename numbers, estimate
   completeness from max track number. UI never branches on connectivity.
4. **Best-copy selection.** When duplicate recordings compete, prefer the better copy — but the review
   caught a circularity: ranking "lossless > lossy" by container alone will pick a **fake-FLAC**
   transcode over a real 320 MP3. Fix: fold a **cheap spectral-cutoff check into the lossless-vs-lossy
   tiebreak** so the copy step doesn't blindly trust the `.flac` extension.
5. **Integrity gate (review addition).** Detect truncated/partial files (declared vs decodable duration,
   container EOF) and **exclude them as match evidence** — a half-downloaded track can produce a
   *confident-wrong* AcoustID match that poisons a whole cluster.
6. **Tolerances are relative + corpus-calibrated**, not magic constants (±Ns fails on remasters/HTOA).
   Separate "same-recording" tolerance (tight, fingerprint-backed) from "same-tracklist-slot" (looser).
7. **CUE / single-file album images** (one FLAC + `.cue` = N logical tracks): **explicitly out of scope
   for v1** — detect and **quarantine** them so they're never silently mistagged. (Splitting would
   re-encode audio, violating the read-only-source guarantee — a separate, budgeted feature.)
8. **VA / classical:** VA disambiguates on **barcode/catalogNo/cover-hash + folder**, never album-title
   text. Classical needs a `Work` entity + work/movement relations — **deferred to post-v1**, routed to
   manual review until then.

Every candidate carries a confidence score and an `EvidenceTrace`. **Auto-accept thresholds are
empirically derived from a labeled corpus, not hardcoded** — and a copy operation never fires on an
unreviewed candidate that online enrichment might still re-rank.

## 7. Enrichment posture (corrected for desktop reality)

- **Default = live API, need-gated, heavily cached, background.** Only ambiguous/unidentified files hit
  `fpcalc`/network. undici + per-service token buckets (AcoustID 3/s, MusicBrainz 1/s, Discogs 60/min),
  content-addressed cache + single-flight + negative cache, backoff honoring `Retry-After`, circuit
  breaker. A **mandatory descriptive User-Agent** (app, version, contact) is a CI-tested invariant —
  bursting/anonymous requests can ban everyone behind a NAT.
- **The MusicBrainz Postgres replica is cut from the MVP.** The synthesis leaned on a local replica as
  the "primary bulk source above ~50k items," but the review is right: a replicating Postgres (~50GB+,
  mbslave, ops) is a server-admin task, not a desktop install. If a bulk path is ever needed, ship a
  **prebuilt, read-only, pruned MB slice** (SQLite/Parquet, refreshed via app updates) — never ask users
  to run Postgres.
- **Accept that full fingerprinting of 1M files is an overnight/opt-in batch, not a "cheap background
  upgrade."** fpcalc *decodes* every file; AcoustID at 3/s ≈ multiple days for 1M. So: **prioritize the
  files that most need it** (low tag confidence first), make the product useful at *any* % enriched, and
  handle sleep/wake/network-loss/app-restart in the limiter+resume logic.
- **The offline + tag + heuristic path is the real default at scale** — design it to be genuinely good,
  not a degraded fallback.
- **Discogs gets its own cache policy:** short TTL (<6h display freshness), no long-term retention, no
  bulk/offline use, excluded from any export (ToS — §10).

## 8. Insights & owner profiling (corrected)

- **Collection insights** run as plain **SQLite `GROUP BY`** on the real (sub-1M) library for v0/v1 —
  fast enough; DuckDB only if profiling proves it's the bottleneck. Metrics: normalized genre
  distribution, format/lossless donut, bitrate/sample-rate/bit-depth histograms, album completeness,
  duplicate clusters, cover-art coverage, tagging-hygiene score, opt-in **fake-FLAC/transcode detection**
  (spectral brickwall test).
- **Owner profiling — lead with signals that survive copying.** Your `2024-10-30` mass-mtime proves the
  review's point: for a re-copied hoard, filesystem timestamps are *already fiction at first scan*. So:
  - **Primary:** release-year distribution, **classic-vs-new** from release dates, genre/taste centroid,
    breadth-vs-depth (entropy/Gini), completionist index, lossless-trajectory-by-era, mainstream-vs-obscure.
  - **Bonus, gated:** acquisition-cadence/build-history timeline — rendered **only** when a reliability
    detector says timestamps aren't collapsed to an import day; mine survivable signals (purchase/date-added
    tags, filename date stamps) first. Otherwise show "insufficient reliable history" and say why.
  - **Privacy:** 100% local, no telemetry; opt-in export; one-click forget-profile; every inference shows
    confidence + plain-language "why"; ranked archetypes, never a single verdict. Owner-profile output and
    EXIF GPS are **classified sensitive** — a redaction rule keeps them out of pino logs / any OTel exporter.

## 9. Roadmap — re-cut for fastest time-to-value

> The synthesis roadmap (M0–M7, ~45–54 wks) front-loaded infrastructure: no album until ~week 15–18, no
> file on disk until ~week 20–24, and it hardened 1M-scale throughput *before validating reconstruction
> quality at all*. The sequencing review is right — this is the cathedral-before-the-congregation mistake.
> **Re-cut into a vertical slice → dogfood gate → scale, with an explicit kill/pivot checkpoint.**

### Phase V0 — Smallest lovable slice (≈ weeks 1–6) — **the whole point, early**
Thin end-to-end pipe on a **small real library** (your `Selection` folder, a few thousand files — *not*
1M, *not* synthetic):
- Single Electron app, engine as an in-process module (utilityProcess later), better-sqlite3, one OS (yours).
- Walk → read tags (music-metadata) → **naive offline album clustering** (`albumArtist+album+year+folder`,
  track order from numbers, completeness from max track #) → minimal keyboard review list →
  **copy-to-new-tree + tag the copy**.
- **Exit = the killer demo:** a corrected, correctly-tagged copy of *real albums from your drive* on disk,
  originals untouched. Get this in week 4–6.

### Phase V0.5 — Dogfood & kill/pivot gate (≈ weeks 6–8)
- Run V0 on your full `Y:\Car Playlists` collection. Manually inspect reconstructed albums + the copied
  tree. Iterate heuristics on **real failures** (Pink Floyd split, Supertramp no-numbers, the typos).
- **Decision gate:** is offline reconstruction quality good enough to justify building enrichment,
  provenance, scale, and insights? *Define a precision/recall bar on real data before scaling.* If it's
  not good enough, fix heuristics or pivot — before spending the next two quarters.

### Phase V1 — Make it good & trustworthy (after the gate)
Only now add, roughly in this order:
1. **Hybrid enrichment** — fpcalc + AcoustID + MusicBrainz/CAA, need-gated, cached, background; the
   iterative block→fingerprint→re-block loop; multi-disc set-cover; **provenance claims** (now that
   sources compete); the spectral fake-FLAC tiebreak. *(This is what turns the typo'd `Under Presure`
   and orphaned Eagles track into correct releases.)*
2. **Organize hardening** — path templating (NFC, cross-platform sanitization, multi-disc layout),
   dry-run diff with collision/disk-space/path-length checks, copy→hash-during-copy→tag-the-copy→
   journaled resume, cover-art provenance/conflict policy.
3. **Insights + owner profiling** — SQLite aggregations; release-year-led profiling with the gated timeline.
4. **Scale hardening** — *staged*: 10k real → 100k → 1M. SQLite-as-queue resumability, credit-based IPC
   backpressure, inode-independent **content-hash move-reattachment** (so decisions survive on
   FAT/exFAT/SMB), per-component memory budget for an **8GB minimum-spec** machine, heap watchdog that
   *enforces* the budget, I/O wall-clock model (HDD cold scan, decode, TB copy amplification — same-disk
   vs cross-disk), tiered test corpus (small-clean / large-clean / **large-messy** / TB-realistic-audio).

### Phase V2 — Images & video (separate post-launch track, ≈ 8–10 wks)
Reuse the proven `Grouping`/candidate/organize machinery: photos→events (time-gap + GPS DBSCAN,
RAW+JPEG/live-photo pairing, screenshot classification), video→series/home-events (ffprobe, sparse
keyframe content-dedup, filename series parse). Don't let it add weight to music milestones.

### Phase V3 — Public release polish (only once the loop is loved)
Code-sign/notarize, delta auto-update, accessibility, full Playwright Electron E2E, soak harness,
**CI license-scan gate + third-party-notices**. The first user (you) needs none of this.

> **Staged scale targets, not a 1M cliff.** "10k real files works and is loved → 100k → 1M," each tied to
> validated value. Throughput claims (e.g. "1M scan in single-digit minutes") are **SSD/warm-cache only**
> and false on the HDDs where hoards actually live — surface a real ETA, don't promise a number.

## 10. Licensing & ToS (the landmines)

The legal lens rated several of these **critical/high** — any one can block a paid release or trigger an
API ban. Action: a **per-source/per-field license ledger** in the data model, and the commercial decision
in §3 made *before* architecture lock.

| Source | Reality | Required action |
|---|---|---|
| **MusicBrainz** | Genres/tags/Live-Data-Feed are **CC BY-NC-SA**, *not* CC0 (only some dumps are CC0) | Visible in-app attribution; honor NonCommercial (or segregate CC0-only fields for any commercial build); license column per claim |
| **AcoustID** | Free **non-commercial only**; commercial needs AcoustID OÜ license; **no offline substitute** | Decide commercial posture; user-supplied key + accepted-terms screen; in-app disclosure |
| **Discogs** | ToS **forbids** durable/offline caching (>6h stale display, no long-term storage); Restricted Data = no commercial | Source-specific short-TTL cache, no bulk/offline, never in exports; mandatory UA + per-user token |
| **fpcalc / ffmpeg** | License is **build-dependent** — FFTW3 backend = **GPL**; only ffmpeg/KissFFT backends keep it LGPL | Pin exact build provenance + FFT backend in CI; LGPL configure flags (no `--enable-gpl`); ship notices + source offer; subprocess isolation as a compliance guarantee; CI license-scan gate |
| **Cover Art Archive** | Images are **third-party copyrighted**, not open data | Personal-use/local embedding only; never in any shareable export; per-image provenance + attribution |
| **GeoNames / MB-popularity datasets** | GeoNames = CC BY 4.0; MB-derived popularity inherits NC-SA | Attribution in about/licenses; derive popularity only from CC0 MB fields |
| **The user's own library** | A messy 1M hoard plausibly contains ripped media | Position strictly as a personal organizer; **no sharing/sync/P2P/acquisition features** without legal review |

## 11. Top risks (carried forward)

1. **Native-module ABI + binary bundling** across OS×arch×Electron — mitigate with pinned versions,
   electron-rebuild + prebuilds in a CI matrix, `asarUnpack` + startup self-test, a **packaged smoke test
   gating every release**, WASM fallbacks; *minimize the native surface*.
2. **Reconstruction correctness** (multi-disc, over-merge, VA/classical, fake-FLAC best-copy,
   truncated-file false matches) — set-cover inversion + independent-signal corroboration + integrity gate
   + copy-only/no-auto-delete + explainable traces + a **messy** labeled corpus driving threshold tuning.
3. **Enrichment intractability at 1M** (rate limits, decode hours, no viable replica for normal users) —
   need-gating, prioritized fingerprinting, "useful at any %", offline-path-as-real-default.
4. **Memory/scale blowup** — SQLite is the only large collection; stream everything; BK-tree/LSH on disk
   not resident; explicit memory budget + enforcing watchdog; staged scale.
5. **Timestamp-based profiling is fiction for the target persona** — gate the timeline; lead with
   release-year-derived signals.
6. **Licensing** (§10) — the commercial decision + license ledger + CI license gate.

## 12. Open questions to resolve before V1

- **Commercial vs non-commercial** (gates §10). *Recommended: non-commercial/personal.*
- **Minimum-spec target machine** (RAM/CPU/disk) — every "bounded/interactive" claim needs it. *Suggest 8GB / SSD-assumed-but-HDD-tolerant.*
- **Labeled corpus sourcing** — known-good library deliberately scattered/corrupted + a hand-labeled sample of *real* mess. Named, budgeted before the V0.5 gate.
- **Destination path template** default (e.g. `AlbumArtist/[Year] Album/NN - Title`) and multi-disc layout (`Disc N/` vs `N-NN`).
- **CUE/single-file images** — confirm quarantine-for-v1 is acceptable for your collection.
- **Engine package scope name** — `@sommelier/*` proposed.
