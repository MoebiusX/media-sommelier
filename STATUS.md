# STATUS — media-sommelier build tree

> The doctrine's HANDOFF artifact. The plan is a tree: **Phases → Tasks → Leaves**.
> Each node is `todo` / `in-progress` / `done(gate passed)`. A node is `done` **only** when its
> named GATE command was actually run green — never on inspection. Update this file at every checkpoint
> so a fresh session resumes without re-deriving the plan.
>
> **Last full-tree verification: 2026-06-23** — `npm test` → 125 passed (19 files); `npm run typecheck`
> clean; `npm run build:web` clean.
>
> **MVP COMPLETE (2026-06-23).** Both reconstruction axes now plan AND execute: folder-based (Organize
> naming scheme) and tag-based (metadata). The app does the full arc: ingest → browse/play (lyrics, Auto
> DJ, EQ/night/crossfade, ReplayGain) → reconstruct (folders OR metadata) → organize into a clean COPY
> tree → drive-sync. Light/dark themes. Originals never mutated.
>
> **Latest feature (2026-06-23, `feat/organize-by-metadata` → `develop`): organize BY metadata (plan +
> execute).** `metadataCandidates()` (`src/engine/reconstruct/metadataAlbums.ts`, shares `bucketize` with
> `groupByMetadata`) turns the (album-artist, album) tag grouping into `AlbumCandidate[]` with collision-
> free disc positions (keep real trackNo when free, else next slot); conf ≤0.75 + evidence (I4). The
> organize child-process worker gains a `metadata` mode (builds candidates from the indexed catalog, uses
> the indexed root as the dest-outside-source guard — and now hard-fails if that root is missing); reuses
> `planOrganize` + `executePlan` (copy-only, hash-verified, collisions failed, idempotent). `POST
> /api/organize/metadata/plan` (dry run) + `/api/organize/run` `mode:'metadata'`; web "Reorganize by
> metadata" panel (`MetadataSim`). Reviewer-PANEL audited (4 lenses → SAFE TO MERGE). Verified live: plan
> over the real catalog = 9,432 files, 0 collisions/skipped; bounded execute copied real files into the
> `Artist/Album/NN - Title` tag tree (atomic temp→rename), source untouched. Gates: `typecheck` + `test`
> (125, +2) + `build:web` green.
>
> **Feature (2026-06-23, `feat/metadata-reconstruction` → `develop`): metadata album reconstruction
> + simulate.** Folder `reconstruct()` groups by where files live; this groups by what tags SAY. New pure
> engine `groupByMetadata` (`src/engine/reconstruct/metadataAlbums.ts`) buckets tag-level tracks by
> (album-artist, album) — `normalize` + `stripDiscTokens` so disc/edition variants merge — and flags
> "integrated" albums whose tracks span >1 source folder. Confidence capped ≤0.75 + evidence (I4). Server
> `GET /api/reconstruct/metadata` runs it over the indexed `tracks` table (instant, read-only); web
> `MetadataSim.tsx` panel in Organize shows a headline + stat chips + integrated-album cards (with the
> folders each was scattered across). On the real library: **228 integrated albums reassemble 3,245
> tracks** folders had scattered (compilations filed one-track-per-folder, etc.). Pure/offline/no deps.
> Gates: `typecheck` + `test` (123, +4) + `build:web` green; reviewer-audited; verified live.
>
> **Feature (2026-06-23, `feat/premium-dark-theme` → `develop`): premium dark theme.** Decoded the
> "advanced/sophisticated" dashboard aesthetic into the DARK theme (CSS-only): ambient bloom behind the app
> (`--app-bloom`), richer accent gradient blue→violet→mint (`--accent-grad`) on brand mark / primary+play
> buttons / avatars, colored glow on the brand + active nav/track accent bars (`--glow-accent*`), glass-edge
> inset highlight on panels/stat/tracks (`--surface-hi`), and gradient "ink" on page titles + brand name
> (`--title-grad`). All token-driven and **neutralized under `[data-theme='light']`** so light stays clean.
> Verified live in both themes; `typecheck` + `test` (119) + `build:web` green; zero console errors.
>
> **Feature (2026-06-23, `feat/light-theme` → `develop`): light theme + dark/light toggle.**
> Theme-sensitive hardcoded colors tokenized (text-on-accent, scrollbar, cover fallback, player bar,
> lyrics overlay) into CSS vars; `:root[data-theme='light']` overrides the palette (deepened accents for
> white) with dark as default. `web/src/theme.ts` resolves stored choice → OS `prefers-color-scheme`; a
> sun/moon toggle in the sidebar foot persists it; an inline script in `index.html` applies it pre-paint
> (no flash). Gates: `typecheck` + `test` (119) + `build:web` green; verified live (toggle + persist +
> reload, both themes across Library/album/player/Overview; zero console errors).
>
> **Feature (2026-06-23, `feat/ui-navigation-polish` → `develop`): navigation reorg + UI polish.**
> Sidebar extracted to `web/src/Sidebar.tsx`: grouped nav (Listen: Library/Playlists/Auto DJ · Manage:
> Organize/Sync · Overview), **lands on Library** by default (was Organize); collapsible to an icon rail
> (persisted) + **drag-to-resize** width (persisted, 200–360px; the `.app` grid column follows via
> `auto 1fr`); a **now-playing card** (cover + title/artist + EQ). Bolder content refresh (CSS-only):
> artist rows (hover accent bar + chevron slide), album cards (hover lift + cover shadow), track table
> (elevated surface + active-row accent bar), buttons (lift + primary glow), bigger page titles. Auto DJ
> moved into the Listen group (`AutoDjLauncher` removed). Gates: `typecheck` + `test` (119) + `build:web`
> green; reviewer-audited (SAFE TO MERGE); verified live (collapse 248↔64, resize→312 persisted, routing,
> now-playing card, refreshed Library/album/track views; zero console errors).
>
> **Feature (2026-06-23, `feat/player-audio-tier2` → `develop`): player sound quality — Tier 2.**
> Built on the Tier 1 graph. **(1) EQ presets** — 3 biquad bands (lowshelf 120Hz / peak 1.5kHz / highshelf
> 6kHz), Flat/Bass/Vocal/Treble. **(2) Night/room mode** — a `DynamicsCompressorNode` (+makeup gain) that
> lifts quiet passages so vocals carry across a room; transparent bypass (ratio 1) when off. **(3) Output
> picker** — `AudioContext.setSinkId` (Chromium, feature-detected, graceful). **(4) Equal-power crossfade**
> — both `<audio>` elements routed through the graph (`el → rg → fade → shared EQ/comp/makeup/userGain`);
> the inactive element preloads the next track, and on automatic track-end an equal-power ramp fades across
> and role-swaps which element is active. Opt-in (Off/2/4/8s, persisted) so default is unchanged; album
> seams (same albumId) stay gapless; manual transport cancels any in-flight fade. Chain is
> `rg → EQ → compressor → makeup → userGain(volume) → destination` (volume last). New `AudioSettings`
> popover in the PlayerBar. Gates: `typecheck` + `test` (119) + `build:web` green; reviewer-audited;
> verified live (Bass +6/+2 dB; night ratio 5/−32 dB/+5 dB makeup; cross-album crossfade equal-power
> 0.6²+0.8²=1 then a→b swap; same-album advanced gaplessly; manual next cancelled cleanly; zero errors).
>
> **Feature (2026-06-23, `feat/player-sound-quality` → `develop`): player sound quality — quick
> wins.** A single Web Audio graph now backs playback: `MediaElementSource → normGain (ReplayGain) →
> userGain (perceptual volume) → destination` (built lazily on the first user gesture; element output
> moved off `.volume` onto the graph). **(1) Perceptual volume** — the linear slider is mapped through a
> dB taper (`sliderToGain`, −48 dB floor) and persisted to localStorage. **(2) ReplayGain leveling** —
> pure engine `readReplayGain` (`src/engine/inventory/loudness.ts`, reads embedded RG/R128 tags, offline,
> read-only) + cached `GET /api/loudness` + per-track gain applied via `normGain`, album-vs-track aware,
> clamped to peak headroom so positive boosts never clip (a GainNode can exceed unity — `element.volume`
> can't). An "RG" pill shows the applied dB. **(3) Next-track preload** — a hidden warmer `<audio>`
> prefetches the next track + `Cache-Control` on `/api/audio` so advancing reuses cached bytes. Gates:
> `npm test -- loudness` (2) + `typecheck` + `build:web` green; verified live (graph active — slider drag
> kept `element.volume===1`; RG re-normalized per track +0.8→−0.3 dB; warmer prefetched the next track;
> zero console errors). Deferred to Tier 2: EQ, night/room compressor, equal-power crossfade, `setSinkId`.
>
> **Feature (2026-06-23, `develop`): Auto DJ — endless mood/style radio.** New pure engine area
> `src/engine/dj/**`: `classifyGenre` (genre tag → {style, mood} families, offline) + `autoDj` (greedy
> flow sequencer — affinity to target mood/style/era + flow bonus + artist diversity + injectable RNG,
> evidence trace per pick). Server `GET /api/dj/moods` (vibes present in the playable library + counts)
> and `POST /api/dj/queue` (seed/mood/style/artist/exclude → ordered PlayerTracks). Web: player
> `startAutoDj`/`stopAutoDj` + endless auto-extend (tops the queue up on-vibe near the end), an `AutoDj`
> picker (sidebar launcher always visible + PlayerBar button) and a live now-playing pill. Gates:
> `npm test -- autodj` (9) + `typecheck` + `build:web` green; verified live (Chill station coherent;
> queue auto-grew 40→60; zero console errors). Honest scope: mood is genre-derived (no audio analysis).
>
> **Feature (2026-06-22, `develop`): player lyrics + full-screen view.** Engine `readLyrics`
> (`src/engine/inventory/lyrics.ts`, offline: `.lrc`/`.txt` sidecar → embedded SYLT/USLT, read-only) +
> `GET /api/lyrics` (server2, graceful lrclib.net online fallback, in-memory cached) + a full-screen
> React overlay (`web/src/Lyrics.tsx`) with synced karaoke auto-scroll, font scaling, and a true
> Fullscreen toggle so it reads from across the room. Gates: `npm test -- lyrics` (7) + `typecheck` +
> `build:web` green; verified live against the indexed library (synced lyrics, autoscroll centering).
>
> **Two numbering axes, don't conflate them:** `P0–P8` below are the doctrine's *architectural layer*
> phases (the `src/engine` layout). `V0–V3` in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
> are *value milestones*. The frontier (§ Frontier) maps the plan's deferred V1/V2 items onto new nodes.

## Invariants (inherited verbatim by every node)

- Source media is READ-ONLY. Only writes: SQLite under `data/`, and the organized COPY tree.
- Pure engine: `src/engine/` has zero http/Electron/DOM imports. CLI + tests + server reuse it verbatim.
- Offline-first: reconstruction works with zero network. Enrichment is a later, optional, graceful-degrade layer.
- TS strict + `noUncheckedIndexedAccess`, Node ≥22, ESM/NodeNext, tsx + vitest.
- Reconstruction confidence is offline-capped ≤ 0.75; every grouping carries a "why grouped" evidence trace.
- Stack is locked: music-metadata (read), node-taglib-sharp (write copies only), better-sqlite3 (WAL). No new deps without asking.

---

## The tree

Legend: `[x]` done(gate passed) · `[~]` in-progress · `[ ]` todo

### P0 — Substrate · `done(gate passed)`
Shared domain vocabulary + string helpers every phase imports.
- Scope: `src/engine/types.ts`, `src/engine/text.ts`, `src/engine/index.ts` (barrel), `test/text.test.ts`
- Interface: imports nothing → exports the `types.ts` domain types + `text.ts` helpers (`normalize`, `titleKey`, `stripDiscTokens`, `plausibleDurationMs`, …)
- Gate: `npm test -- text` (21) + `npm run typecheck` → **green 2026-06-22**
  - [x] P0Task1 — `types.ts` (typecheck-gated)
  - [x] P0Task2 — `text.ts` (`text.test.ts`)

### P1 — Inventory · `done(gate passed)`
Tree or `dir /s` listing → `MediaFileRecord[]`, read-only.
- Scope: `src/engine/inventory/**`, `test/wait.test.ts`
- Interface: imports `./types.js`, `./text.js` → exports `parseDirListing`, `walk/walkToArray/waitForPath`, `readTags/TagInfo`, `readCover/Cover`
- Gate: `npm test -- wait` (2) → **green 2026-06-22**
  - [x] P1Task1 — `dirListing.ts` · [x] P1Task2 — `walk.ts` (`wait.test.ts`) · [x] P1Task3 — `tags.ts` · [x] P1Task4 — `cover.ts` · [x] P1Task5 — `lyrics.ts` (`lyrics.test.ts`, 7)

### P2 — Reconstruct (the heart) · `done(gate passed)`
`MediaFileRecord[]` → `ReconstructionReport`; confidence ≤ 0.75; evidence trace per candidate.
- Scope: `src/engine/reconstruct/**`, `test/reconstruct.test.ts`, `test/reconstruct-flags.test.ts`
- Interface: imports `./types.js`, `./text.js` → exports `parseName`, `reconstruct`
- Gate: `npm test -- reconstruct` (14+6) → **green 2026-06-22**; named fixtures verified via `reconstruct:sample` (Pink Floyd *Echoes* sibling-disc re-merge, Supertramp `no-track-numbers`, Eagles/Marc Antoine `orphan`)
  - [x] P2Task1 — `parseName.ts` · [x] P2Task2 — `reconstruct.ts`

### P3 — Organize (the COPY-write spine) · `done(gate passed)`
`AlbumCandidate[]` → idempotent `OrganizePlan` → copy+tag into `Artist/Album/NN - Track`. **Only phase that writes files.**
- Scope: `src/engine/organize/**`, `test/organize.test.ts`, `test/organize-multidisc.test.ts`, `test/execute.test.ts`
- Interface: imports `./types.js`, `./text.js` → exports `planOrganize/sanitizeSegment/ORGANIZE_PRESETS/OrganizePlan/…`, `writeTrackTags/TrackTags`, `executePlan/ExecuteReport/…`
- **Load-bearing HALT:** never writes/renames/deletes a *source* file — dest copy + SQLite only.
- Gate: `npm test -- organize` (6+8) + `npm test -- execute` (4) → **green 2026-06-22**
  - [x] P3Task1 — `plan.ts` · [x] P3Task2 — `tag.ts` · [x] P3Task3 — `execute.ts`

### P4 — Library scan & media stats · `done(gate passed)`
Browseable catalog + per-format stats; photo/video read paths.
- Scope: `src/engine/library/**`, `test/library-stats.test.ts`, `test/video-stats.test.ts`
- Interface: imports `./types.js`, `./inventory/tags.js` → exports `scanLibrary/Track`, `scanLibraryCached`, `computeLibraryStats/LibraryStats`, photo/video readers + stats
- Gate: `npm test -- library-stats` (3) + `npm test -- video-stats` (7) → **green 2026-06-22**
  - [x] P4Task1 `scan.ts` · [x] P4Task2 `catalog.ts` · [x] P4Task3 `stats.ts` · [x] P4Task4 `photos.ts` · [x] P4Task5 `videos.ts`

### P5 — Insights & Report · `done(gate passed)`
Collection insights + owner profiling; static HTML report.
- Scope: `src/engine/insights/**`, `src/engine/report/**`, `test/insights.test.ts`
- Interface: imports `./types.js`; consumes P2's `ReconstructionReport` → exports `computeInsights/InsightsReport/OwnerProfile/…`, `renderHtml`
- Gate: `npm test -- insights` (6) → **green 2026-06-22**
  - [x] P5Task1 — `insights/insights.ts` · [x] P5Task2 — `report/html.ts`

### P6 — Enrich (later, optional online layer) · `done(gate passed)`
Fingerprint + AcoustID + MusicBrainz lift for ambiguous candidates; graceful-degrade to offline.
- Scope: `src/engine/enrich/**`, `test/acoustid.test.ts`, `test/match.test.ts`, `test/clients.test.ts`, `test/enrich.test.ts`
- Interface: imports `./types.js` → exports `fingerprintFile/fpcalc*`, `AcoustIdClient`, `MusicBrainzClient/extractTracklist`, `selectBestRelease/scoreRelease`, `enrichCandidate/enrichTop`
- **Load-bearing HALT:** no network call in the core reconstruction path — P2 must pass with the network unplugged.
- Gate: `npm test -- match acoustid clients enrich` (5+3+5+5) → **green 2026-06-22** (canned responses, no live network)
  - [x] P6Task1 `fpcalc.ts` · [x] P6Task2 `acoustid.ts` · [x] P6Task3 `musicbrainz.ts` · [x] P6Task4 `match.ts` · [x] P6Task5 `enrich.ts`

### P7 — CLI (composition root) · `done(gate passed)`
Wire inventory → reconstruct → (enrich) → organize over the engine, verbatim reuse.
- Scope: `src/cli/**`
- Interface: imports `../engine/index.js` only → exports the `sommelier` bin
- Gate: `npm run reconstruct:sample` (committed `sample-collection.dir.txt`, end-to-end, no source touched) → **green 2026-06-22**
  - [x] P7Task1 — `cli/index.ts`

### P8 — App server + Web UI · `done(gate passed)`
Local API (jobs, ingest, SQLite catalog) + React app (library, playlists, duplicates, organize, drives, player).
- Scope: `src/server2/**`, `src/server/**` (legacy), `web/**`, `test/jobs.test.ts`
- Interface: server2 imports `../engine/index.js` + `better-sqlite3`; `web/src/api.ts` talks to server2 over HTTP (no engine import in the browser) → exports `JobService` + HTTP routes; the React app
- Gate: `npm test -- jobs` (6) + `npm run build:web` (44 modules, clean) → **green 2026-06-22**
  - [x] P8Task1 `server2/db.ts` · [x] P8Task2 `server2/jobs.ts` (`jobs.test.ts`) · [x] P8Task3 `server2/ingest.ts` · [x] P8Task4 `server2/organize-worker.ts` · [x] P8Task5 `server2/index.ts` · [x] P8Task6 `server/index.ts` (legacy) · [x] P8Task7 `web/**` (`build:web`)

---

## Scope-coverage audit

- Union of P0–P8 covers all of `src/engine/**`, `src/cli/**`, `src/server*/**`, `web/**`, and every `test/*.test.ts`. Strict subset of root scope; no leaf claimed twice.
- **Shared seam (controlled, additive):** `src/engine/index.ts` is created by P0 and append-only-extended by P1–P6 (each phase adds only its own `export` block). Not a conflicting overlap.
- **Deliberately not a phase:** root scaffolding (`package.json`, `tsconfig.json`, vitest config, `test/fixtures/**`) is root-owned, established before P0. `dist/**` (output) and `docs/**` (not in build) are out of scope.

---

## Frontier — `todo` (next decompositions)

The offline spine + online enrichment + app are all `done`. The open work is the plan's deferred items and
the drive-sync follow-ups. Each is an undecomposed node — decompose ONE, review, then execute its children.

- [ ] **F1 — CUE / single-file album images: detect & quarantine** (plan §6.7, §12). Out-of-scope to *split*
      (would re-encode → violates read-only source). Engine must detect `.cue`+single-FLAC and quarantine so
      they're never silently mistagged. New scope likely `src/engine/inventory/**` + a `quarantine` flag on `CandidateFlag`.
- [ ] **F2 — Integrity gate: truncated/partial-file detection** (plan §6.5). Declared-vs-decodable duration /
      container-EOF check; exclude partials as match evidence (a half-download yields confident-wrong AcoustID).
- [ ] **F3 — Spectral fake-FLAC / transcode tiebreak** (plan §6.4, §8). Cheap spectral-cutoff check folded into
      lossless-vs-lossy best-copy selection so the copy step doesn't trust the `.flac` extension. Opt-in.
- [ ] **F4 — Scale hardening, staged 10k → 100k → 1M** (plan §9 V1.4). Content-hash move-reattachment
      (decisions survive on FAT/exFAT/SMB), per-component memory budget + enforcing watchdog, real-ETA I/O model.
- [ ] **F5 — Provenance: append-only `MetadataClaim` + materialized `ResolvedField`** (plan §5, deferred). Only
      worth it once multiple sources compete to overwrite each other; pairs with a per-source/per-field license ledger (§10).
- [ ] **F6 — Drive-sync v2** (memory: [drive-sync-roadmap](memory)). Deferred from shipped v1 (hand-picked,
      additive-only): transcoding-on-sync, smart-rule selection, true-mirror (deletion propagation).

## Next node

**Recommended: decompose F2 (integrity gate)** — smallest, highest-leverage, and it *protects* the already-green
P2/P6 gates (a truncated file currently can poison a cluster's match). It touches `src/engine/inventory` +
`src/engine/enrich/enrich.ts` with a focused new test, and it adds no dependency or network. Alternative if you
want user-visible value first: **F1 (CUE quarantine)**.

## Open HALT questions

- **None blocking.** All gates green; no source-write path is in question; no new dep/framework/network is pending.
- Watch for HALT during F-node work: F1/F2 must only *flag/quarantine*, never rewrite source; F3 must stay opt-in
  and off the core reconstruction path; F5's license ledger gates any future commercial posture (plan §3, §10) —
  that commercial vs non-commercial decision is still **open** and must be made before a license-bearing build.
