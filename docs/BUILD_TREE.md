# Media Sommelier — Build Tree (Phase / Task / Leaf Decomposition)

## (A) Framing

This is a **leaf-level Phase → Task → Leaf decomposition** of the Media Sommelier build, grounded in the **real repository** (real file paths, real exports, real `npm` gate commands — nothing invented). Media Sommelier reconstructs a scattered, mistagged music collection into real albums and copies them into a clean tree, **never mutating originals**. A *leaf* is one real file (plus its test) implementable in one sitting. The five project invariants are carried down to **every** leaf: **(I1)** source media is READ-ONLY — the only writes are SQLite under `data/` and the organized COPY tree; **(I2)** the engine under `src/engine/**` has ZERO http/Electron/DOM imports; **(I3)** offline-first — reconstruction needs zero network; **(I4)** offline confidence is hard-capped `≤ 0.75` and every grouping carries a `why-grouped` evidence trace; **(I5)** TS-strict + `noUncheckedIndexedAccess`, Node ≥ 22, ESM/NodeNext, `tsx` + `vitest`, stack locked — no new deps. Where the repo co-locates several capabilities in one real file (e.g. `reconstruct.ts`), the Tasks are presented as the internal stages of that **one** leaf; shared leaves (`src/cli/index.ts`, `src/engine/index.ts`) are defined once at first use and cross-referenced afterward.

---

## (B) Overview Tree (Project → Phases → Tasks)

```
MEDIA SOMMELIER  (scattered MediaFileRecord[] → reconstructed albums → clean COPY tree + insights)
│
├─ Phase 1 — Foundations
│    ├─ Task 1.1 — Project skeleton
│    ├─ Task 1.2 — Domain vocabulary
│    ├─ Task 1.3 — Shared text helpers
│    └─ Task 1.4 — Messy fixture
│
├─ Phase 2 — Inventory & parsing
│    ├─ Task 2.1 — Inventory sources (read-only IO adapters)
│    └─ Task 2.2 — Filename parsing
│
├─ Phase 3 — Reconstruction
│    ├─ Task 3.1 — Grouping                 [internal stage of reconstruct.ts]
│    ├─ Task 3.2 — Multi-disc merge         [internal stage of reconstruct.ts]
│    ├─ Task 3.3 — Artist attribution       [internal stage of reconstruct.ts]
│    ├─ Task 3.4 — Confidence + evidence     (exports reconstruct)
│    └─ Task 3.5 — CLI to see it             (src/cli/index.ts · reconstruct subcommand)
│
├─ Phase 4 — Organize
│    ├─ Task 4.1 — Tag the COPY              (commits TrackTags)
│    ├─ Task 4.2 — Plan the clean tree
│    ├─ Task 4.3 — Copy · verify · publish
│    └─ Task 4.4 — CLI: reconstruct → plan → dry-run | execute   (extends 3.5.1)
│
└─ Phase 5 — Insights
     ├─ Task 5.1 — Collection facts
     ├─ Task 5.2 — Honest owner profile     (same leaf as 5.1)
     ├─ Task 5.3 — Static report
     └─ Task 5.4 — CLI surface              (extends 3.5.1)
```

---

## (C) The Full Tree

### Phase 1 — Foundations

Project skeleton, the domain type ledger, shared pure text helpers, and a deliberately messy `dir /s` fixture — the substrate every later phase imports from.
**Milestone:** a compiling, test-runnable ESM/TS-strict project whose type vocabulary and text helpers exist and whose messy fixture loads.
**Exit gate:** `npm run typecheck` clean + `npm test -- text` (21 green) + the fixture parses via `npm run reconstruct:sample`.

```
Phase 1 — Foundations
│
├─ Task 1.1 — Project skeleton
│    Capability: a locked, reproducible ESM/TS-strict toolchain (build/typecheck/test/cli/reconstruct:sample) with the `sommelier` bin and zero-config vitest.
│    Files/modules: package.json, tsconfig.json.   Depends on: nothing (root of the tree).
│    │
│    ├─ Subtask 1.1.1 — package.json
│    │    Responsibility: pin the locked dependency set, declare `type=module`, the `sommelier` bin, and the npm scripts that ARE every later phase's gate commands.
│    │    Imports: nothing (manifest).   Exports (scripts/bin consumed downstream): build="tsc -p tsconfig.json", typecheck="tsc -p tsconfig.json --noEmit", test="vitest run", cli="tsx src/cli/index.ts", reconstruct:sample="tsx src/cli/index.ts reconstruct test/fixtures/sample/sample-collection.dir.txt --from-listing"; bin sommelier → dist/cli/index.js; deps better-sqlite3/music-metadata/node-taglib-sharp (+exifr/ffmpeg-static/ffprobe-static), devDeps tsx/typescript/vitest.
│    │    Invariants bound: (I5) Node>=22, ESM/NodeNext, tsx+vitest, stack locked — NO new deps; (I1) only data/ + COPY tree ever written.
│    │    Test: `npm test -- text` and `npm run reconstruct:sample` both resolve through these scripts; vitest is zero-config (no vitest.config.ts in repo).
│    │    Gate: `npm run typecheck` (script resolves) + `npm test -- text` (script resolves, 21).
│    │
│    └─ Subtask 1.1.2 — tsconfig.json
│         Responsibility: enforce TS strict + noUncheckedIndexedAccess under NodeNext module/resolution so `.js`-suffixed ESM specifiers (e.g. `./types.js`) compile across the engine.
│         Imports: nothing (compiler config).   Exports: the compiler contract consumed by `tsc -p tsconfig.json` (build) and `--noEmit` (typecheck).
│         Invariants bound: (I5) TS strict + noUncheckedIndexedAccess, ESM/NodeNext.
│         Test: `npm run typecheck` exits clean over src/** + test/**.
│         Gate: `npm run typecheck`.
│
├─ Task 1.2 — Domain vocabulary
│    Capability: the single source of truth for every engine type, plus the public barrel created here and append-extended by later phases.
│    Files/modules: src/engine/types.ts (R5 anchor — committed FIRST, imports nothing), src/engine/index.ts (the barrel).   Depends on: 1.1 (toolchain).
│    │
│    ├─ Subtask 1.2.1 — src/engine/types.ts
│    │    Responsibility: commit the WHOLE domain type ledger (the records every downstream leaf imports by `./types.js`) in one import-free file — the R5 anchor.
│    │    Imports: nothing.   Exports: MediaType, MediaFileRecord, ParsedName, DiscGroup, TrackSlot, CandidateFlag, AlbumCandidate, DuplicateCandidate, ReconstructionReport.
│    │    Invariants bound: (I2) zero http/Electron/DOM imports; (I4) AlbumCandidate.confidence typed 0..0.75 with an evidence:string[] "why grouped" trace; (I5) TS-strict.
│    │    Test: consumed transitively by every engine test; `npm run typecheck` proves the ledger compiles and downstream `./types.js` imports resolve.
│    │    Gate: `npm run typecheck`.
│    │
│    └─ Subtask 1.2.2 — src/engine/index.ts   [the public barrel — CREATED HERE, append-extended by P2–P5]
│         Responsibility: the public engine barrel — re-export the type ledger and (as later phases append) every module's API; in P1 it must at minimum re-export the types and the text helpers, the only existing engine surface.
│         Imports: ./types.js (type-only re-export of the full ledger), ./text.js (humanBytes, normalize, titleKey, plausibleDurationMs); later phases APPEND inventory/library/reconstruct/organize/report/insights/enrich blocks (a controlled additive seam, NOT a conflicting overlap).
│         Exports: the union of those re-exports (the engine's public API; the CLI imports `../engine/index.js` ONLY).
│         Invariants bound: (I2) pure barrel, no http/Electron/DOM imports; (I3) offline — re-exports only offline-capable engine surface; (I5) TS-strict + ESM/NodeNext (the contract that makes the `.js`-suffixed re-exports compile); append-only seam (no conflicting overlap).
│         Test: `npm run typecheck` proves every re-export resolves; downstream `import { ... } from '../engine/index.js'` compiles.
│         Gate: `npm run typecheck`.
│
├─ Task 1.3 — Shared text helpers
│    Capability: the pure, dependency-free string toolkit (ext/media classifiers, normalize, disc-token stripping, title keys, year/byte/duration helpers) every later phase reuses verbatim.
│    Files/modules: src/engine/text.ts (+ test/text.test.ts).   Depends on: 1.1 (toolchain). Imports nothing from 1.2 (text is itself an R5-anchor leaf).
│    │
│    └─ Subtask 1.3.1 — src/engine/text.ts
│         Responsibility: pure string helpers — ext/media classifiers, path basename/stem, normalize, stripDiscTokens, titleKey, findYear, humanBytes, and the physically-impossible-bitrate duration sanity check — shared by every downstream phase.
│         Imports: nothing.   Exports: isAudioExt, isLosslessExt, mediaTypeForExt, extOf, basename, stem, normalize, stripDiscTokens, titleKey, findYear, humanBytes, plausibleDurationMs.
│         Invariants bound: (I2) pure/UI-free, zero imports; (I5) TS-strict + noUncheckedIndexedAccess.
│         Test: test/text.test.ts — normalize collapses diacritics/punct & maps `&`->`and`; stripDiscTokens collapses "(Disc 2)"/"(Remastered…)"; titleKey drops "- Remaster"/"Part …" and returns '' when too short; plausibleDurationMs drops <4 kbps but keeps a 2 h/57 MB audiobook. (21 cases)
│         Gate: `npm test -- text` (21) + `npm run typecheck`.
│
└─ Task 1.4 — Messy fixture
     Capability: the deliberately messy dual-mode input (a committed `dir /s` dump) whose named traps drive every later phase's gate.
     Files/modules: test/fixtures/sample/sample-collection.dir.txt.   Depends on: 1.1 (so reconstruct:sample script exists); its named traps are PROVEN downstream by reconstruct (P3), but the file itself is authored here.
     │
     └─ Subtask 1.4.1 — test/fixtures/sample/sample-collection.dir.txt
          Responsibility: a committed Windows `dir /s` listing of a deliberately messy, scattered, mistagged collection.
          Imports: none (data fixture; parsed by `parseDirListing` at runtime, NOT imported as code).   Exports: none (read as `dir /s` text via the `--from-listing` flag).
          Invariants bound: (I1) source listing is READ-ONLY input — never mutated; (I3) drives the fully-offline reconstruction path; (I4) its traps are what the downstream ≤0.75 confidence cap and evidence trace are proven against. (Data fixture, not engine code — I2/I5 do not apply.)
          Test: its "test" is the named traps reproducing through `npm run reconstruct:sample` — sibling multi-disc folders (Led Zeppelin "The Song Remains The Same" CD 1/CD 2; Pink Floyd "Echoes" re-merge), orphan singles (Marc Antoine "Mediterráneo", Eagles), no-track-number sets (Supertramp), mixed naming schemes, and compilations all surface when P3 reconstruct runs over this listing.
          Gate: the fixture loads/parses via `npm run reconstruct:sample` (Phase 1 exit-gate leg).
```

---

### Phase 2 — Inventory & parsing

**Milestone:** read a folder OR a Windows `dir /s` text dump into a uniform `MediaFileRecord[]`, then parse each audio filename into musical parts (`ParsedName`). Both inventory sources emit the SAME record shape; tag/cover read adapters are READ-ONLY layers over real files.
**Exit gate:** `npm test -- wait` (2 green) + `npm run typecheck`; inventory over `test/fixtures/sample/sample-collection.dir.txt` yields the expected audio record count; `parseName` exercised by the reconstruct tests (`npm test -- reconstruct`).

```
Phase 2 — Inventory & parsing
│  (binds I1 source READ-ONLY · I2 pure UI-free engine · I3 offline · I5 TS-strict/ESM/no-new-deps)
│
├─ Task 2.1 — Inventory sources (read-only IO adapters)
│    Capability: turn either a text dump or a live filesystem subtree into MediaFileRecord[], and
│    READ (never write) embedded tags + cover art from real files. All four leaves emit/consume the
│    SAME record shape committed in P1 types.ts (R2/R5).
│    Maps to: src/engine/inventory/{dirListing,walk,tags,cover}.ts
│    Depends on: P1 src/engine/types.ts (MediaFileRecord, MediaType) + src/engine/text.ts (extOf, mediaTypeForExt).
│  │
│  ├─ Subtask 2.1.1 — src/engine/inventory/dirListing.ts
│  │    Responsibility: parse a committed Windows `dir /s` text dump into MediaFileRecord[] without touching any disk, so reconstruction runs end-to-end on a real-collection sample offline.
│  │    Imports: type { MediaFileRecord } from '../types.js'; { extOf, mediaTypeForExt } from '../text.js'.   Exports: parseDirListing.
│  │    Invariants bound: (I1) reads TEXT only — zero source writes; (I2) pure engine, no fs/http/DOM; (I3) fully offline; (I5) TS-strict.
│  │    Test: covered via reconstruct:sample over test/fixtures/sample/sample-collection.dir.txt — parsing the dump yields the expected audio record count (Directory-of header + dated FILE_LINE rows; `<DIR>`/`.`/`..` skipped; comma-stripped sizes; YYYY-MM-DD mtime).
│  │    Gate: `npm run reconstruct:sample` (expected audio record count) + `npm run typecheck`.
│  │
│  ├─ Subtask 2.1.2 — src/engine/inventory/walk.ts
│  │    Responsibility: async, bounded, symlink-cycle-guarded filesystem traversal producing the SAME MediaFileRecord shape as dirListing, plus a waitForPath poller that blocks until a sleeping/unmounted drive appears.
│  │    Imports: { readdir, stat, realpath } from 'node:fs/promises'; { join, dirname, basename } from 'node:path'; type { MediaFileRecord, MediaType } from '../types.js'; { extOf, mediaTypeForExt } from '../text.js'.   Exports: WalkOptions, walk, walkToArray, WaitOptions, waitForPath.
│  │    Invariants bound: (I1) READ-ONLY traversal — only readdir/stat/realpath, never mutates source; (I2) pure engine (node:fs/path only, no http/DOM); (I3) offline; (I5) TS-strict, no new deps.
│  │    Test: test/wait.test.ts — waitForPath resolves true on the 3rd injected poll; resolves false after timeoutMs with onWait fired (injectable exists/sleep keep it deterministic). (2 cases)
│  │    Gate: `npm test -- wait` (2) + `npm run typecheck`.
│  │
│  ├─ Subtask 2.1.3 — src/engine/inventory/tags.ts
│  │    Responsibility: READ embedded tags + audio properties from one real file via music-metadata, returning a normalized TagInfo (empty object on corrupt/unreadable so the caller falls back to filename).
│  │    Imports: { parseFile } from 'music-metadata'.   Exports: TagInfo, readTags.
│  │    Invariants bound: (I1) READ-ONLY — parseFile only, never writes source; (I2) engine stays UI-free (no http/DOM; music-metadata performs no network access); (I3) local file read, no network; (I5) TS-strict, locked dep music-metadata (no new deps).
│  │    Test: no dedicated test exercises this leaf in this phase; it is consumed indirectly through the Library/insights pipeline that reads TagInfo — correctness proven by `npm run typecheck` over its TagInfo contract (parser is the locked music-metadata dep).
│  │    Gate: `npm run typecheck`.
│  │
│  └─ Subtask 2.1.4 — src/engine/inventory/cover.ts
│       Responsibility: resolve cover art for a track — prefer embedded picture (APIC/FLAC/MP4 covr) via music-metadata, else fall back to a folder image (cover/folder/front…); returns null when none.
│       Imports: { parseFile } from 'music-metadata'; { readFile } from 'node:fs/promises'; { existsSync } from 'node:fs'; { dirname, join } from 'node:path'.   Exports: Cover, readCover.
│       Invariants bound: (I1) READ-ONLY — parseFile/readFile only, never writes source; (I2) engine UI-free; (I3) local reads, no network; (I5) TS-strict, locked dep music-metadata (no new deps).
│       Test: no dedicated test exercises this leaf in this phase; it is consumed indirectly through the cover-serving path that reads Cover — correctness proven by `npm run typecheck` over its Cover contract.
│       Gate: `npm run typecheck`.
│
└─ Task 2.2 — Filename parsing
     Capability: parse one audio filename into ParsedName{trackNo?,discNo?,artist?,title?,scheme,hasTrackNo}
     across the real-world naming schemes, extracting robust track/disc NUMBERS first and best-effort
     artist/title (refined later by the reconstruction layer using folder context).
     Maps to: src/engine/reconstruct/parseName.ts
     Depends on: P1 src/engine/types.ts (ParsedName) + src/engine/text.ts (stem).
   │
   └─ Subtask 2.2.1 — src/engine/reconstruct/parseName.ts
        Responsibility: map a single filename to ParsedName via ordered scheme matchers (discTrack_artist_title → artist_(NN)title → track_rest → artist_title_notrack → unknown), prioritizing reliable track/disc numbers over best-effort artist/title.
        Imports: type { ParsedName } from '../types.js'; { stem } from '../text.js'.   Exports: parseName.
        Invariants bound: (I2) pure engine — no fs/http/DOM, deterministic string parse; (I3) offline; (I5) TS-strict.
        Test: test/reconstruct.test.ts + test/reconstruct-flags.test.ts — parseName proven through reconstruct over the messy fixture (Pink Floyd "(05)Echoes" artist_(NN)title; "101-led_zeppelin-…" discTrack scheme; Supertramp artist_title_notrack no-track-number trap). (14 + 6 cases)
        Gate: `npm test -- reconstruct` (14 + 6) + `npm run typecheck`.
```

---

### Phase 3 — Reconstruction

**Milestone:** scattered `MediaFileRecord[]` are rebuilt into `AlbumCandidate[]` with merged multi-disc sets, an attributed `albumArtist`, an offline-capped `confidence (≤0.75)`, a `flags` list, and an `evidence:string[]` "why grouped" trace — plus a CLI to see it run end-to-end on the messy fixture without touching any source file.
**Exit gate:** `npm test -- reconstruct` (14 + 6 green) + `npm run reconstruct:sample` end-to-end (no source touched; assert every `confidence` ≤ 0.75).

> The repo ships the engine as ONE real leaf — `src/engine/reconstruct/reconstruct.ts` — that internally does grouping + multi-disc merge + artist attribution + scoring/evidence in a single `reconstruct()` pass. Per R3, Tasks 3.1–3.4 are the four internal stages of that one file (no `group.ts`/`multidisc.ts` exist); they all resolve to the same leaf, so the leaf is stated once under Task 3.4 (the stage that exports `reconstruct`). Task 3.5 is the real CLI leaf.

```
Phase 3 — Reconstruction  (records → ReconstructionReport; gate: npm test -- reconstruct  +  npm run reconstruct:sample)
│
├─ Task 3.1 — Grouping  [internal stage of reconstruct.ts; no standalone file]
│    Capability: cluster audio records into folder-albums and assign a normalized release key, so scattered
│      sibling folders that belong to one release collapse together (uses text.normalize / stripDiscTokens).
│    Maps to: src/engine/reconstruct/reconstruct.ts — internal helpers byDir grouping, FolderAlbum,
│      parentOf, commonWordPrefix, the three release-key strategies (prefix:/parent:/stem:/dir:) and byKey bucketing.
│    Produces: the release-key buckets that feed buildCandidate; underpins the multi-folder-merge flag.
│    Depends on: text.ts (normalize, stripDiscTokens, isAudioExt, basename), parseName.ts, types.ts (MediaFileRecord; FolderAlbum is local).
│
├─ Task 3.2 — Multi-disc merge  [internal stage of reconstruct.ts; no standalone file]
│    Capability: re-merge sibling disc folders (inline "Cd 1/Cd 2" stems; dedicated-parent "Vol 1/2" prefixes;
│      bare "CD 2" folders) and detect in-folder multi-disc (3-digit 1xx/2xx filename prefixes).
│    Maps to: src/engine/reconstruct/reconstruct.ts — bareDiscNo, inlineDiscNo, discFromResidual,
│      stripLeadingYearDisc, the slotsByDisc assignment in buildCandidate.
│    Produces: DiscGroup[] per candidate; flags multi-folder-merge, in-folder-multi-disc, partial-disc-set.
│    Trap proven: Pink Floyd "Echoes" sibling-disc re-merge.   Depends on: Task 3.1 (folder-albums), types.ts (DiscGroup, TrackSlot).
│
├─ Task 3.3 — Artist attribution  [internal stage of reconstruct.ts; no standalone file]
│    Capability: pick the albumArtist (consistent filename artist → "Artist - Album" folder convention →
│      structural parent folder → leading token) and detect compilations / various-artists releases.
│    Maps to: src/engine/reconstruct/reconstruct.ts — guessArtist, artistBeforeSep, titleCaseIfLower,
│      albumTitleFrom, refineTitle, COMPILATION_RE.
│    Produces: albumArtist + albumTitle; flag possible-compilation.   Depends on: Task 3.1, parseName.ts, text.ts (normalize, basename, findYear).
│
├─ Task 3.4 — Confidence + evidence  [the stage that exports the public entry point]
│    Capability: score confidence HARD-CAPPED ≤ 0.75, emit the evidence:string[] "why grouped" trace, set the
│      remaining flags (no-track-numbers, orphan, mixed-naming-schemes), and assemble the ReconstructionReport
│      (candidates + duplicates + summary).
│    Maps to: src/engine/reconstruct/reconstruct.ts — buildCandidate (confidence math + flags), buildEvidence,
│      hasGaps, findDuplicates, summarize, uniqueId, round2, the exported reconstruct().
│    Produces: AlbumCandidate.confidence (≤0.75), .evidence, .flags; ReconstructionReport.{candidates,duplicates,summary}.
│    Depends on: Tasks 3.1–3.3, types.ts (AlbumCandidate, CandidateFlag, DuplicateCandidate, ReconstructionReport), text.ts (titleKey, humanBytes, isLosslessExt, findYear).
│  │
│  └─ Subtask 3.4.1 — src/engine/reconstruct/reconstruct.ts   [the ONE real leaf for Tasks 3.1–3.4]
│       Responsibility: in one offline pass, turn MediaFileRecord[] into a ReconstructionReport by grouping files into folder-albums, applying the three multi-disc merge strategies, attributing albumArtist/albumTitle, then scoring confidence (capped ≤0.75), emitting an evidence trace and flags, and folding in duplicates + summary.
│       Imports: `../types.js` (AlbumCandidate, CandidateFlag, DiscGroup, DuplicateCandidate, MediaFileRecord, ReconstructionReport, TrackSlot); `../text.js` (basename, findYear, humanBytes, isAudioExt, isLosslessExt, normalize, stripDiscTokens, titleKey); `./parseName.js` (parseName).   Exports: `reconstruct` (the public entry), re-exports `humanBytes`. (NOTE: src/engine/index.ts APPENDS a reconstruct re-export block — barrel created in P1.)
│       Invariants bound: (I1) reads records only — never writes/renames/moves a source file; (I2) pure engine — zero http/Electron/DOM imports; (I3) offline — no network in the reconstruction path; (I4) confidence clamped `Math.max(0.1, Math.min(0.75, …))` with every candidate carrying an evidence[] trace; (I5) TS-strict + noUncheckedIndexedAccess.
│       Test: test/reconstruct.test.ts (14) — grouping, sibling-disc merge (Echoes), artist attribution, completeness/confidence bounds, evidence present; test/reconstruct-flags.test.ts (6) — no-track-numbers, orphan, in-folder-multi-disc, multi-folder-merge, mixed-naming-schemes, possible-compilation, partial-disc-set emission.
│       Gate: `npm test -- reconstruct` (14+6 green) + `npm run typecheck`.
│
└─ Task 3.5 — CLI to see it
     Capability: a thin shell over @engine that loads an inventory (dir-listing dump or fs walk), runs reconstruct(),
       and prints the report (human or --json, optional --html) — proving the engine is UI-decoupled and source-read-only.
     Maps to: src/cli/index.ts (the `sommelier` bin; `reconstruct` subcommand + report renderer).
     Depends on: Task 3.4 (reconstruct + ReconstructionReport), and the P2 inventory loaders.
   │
   └─ Subtask 3.5.1 — src/cli/index.ts   [the ONE real composition-root leaf — FIRST DEFINED HERE; extended by 4.4.1 and 5.4.1]
        Responsibility: parse argv, load an inventory via parseDirListing (`--from-listing`) or walkToArray (fs walk), call reconstruct(), and render the ReconstructionReport to the terminal (printReport / printCandidate) or as JSON/HTML — the `reconstruct` subcommand is Phase 3's window into the engine.
        Imports: `../engine/index.js` ONLY (parseDirListing, reconstruct, renderHtml, walkToArray, waitForPath, humanBytes, type ReconstructionReport, type AlbumCandidate, type MediaFileRecord, plus organize/insights/enrich symbols for sibling subcommands); `node:fs/promises` (readFile, writeFile); `node:fs` (existsSync, readFileSync).   Exports: none — composition-root bin (`sommelier` → dist/cli/index.js), runs `main()`.
        Invariants bound: (I1) source READ-ONLY — reconstruct path only reads the listing/walk, never writes a source file; (I2) imports the engine barrel only (no engine internals reach into UI); (I3) offline — `reconstruct` needs zero network; (I4) prints each candidate's confidence (color-coded) and evidence trace, never fabricating > 0.75.
        Test: covered end-to-end by the gate `npm run reconstruct:sample` (runs `reconstruct test/fixtures/sample/sample-collection.dir.txt --from-listing`) — exercises the messy fixture (scattered discs, missing track numbers, orphans, mixed schemes) with no source touched.
        Gate: `npm run reconstruct:sample` (end-to-end, no source touched; confidence ≤ 0.75) + `npm run typecheck`.
```

---

### Phase 4 — Organize

**Milestone:** plan a clean destination TREE, then copy → verify-by-hash → tag THE COPY, with the SOURCE held strictly read-only (I1); offline-only (I3); pure UI-free engine (I2); confidence thresholding honours the offline cap ≤0.75 (I4); TS-strict (I5).
**Exit gate:** `npm test -- organize` (6 + 8) + `npm test -- execute` (4) green, AND source checksum identical before/after every run (I1). Plus `npm run typecheck`.

> R5 ordering: `plan.ts` imports `type { TrackTags } from './tag.js'`, so the leaf that COMMITS `TrackTags` (`tag.ts`) precedes the leaf that IMPORTS it (`plan.ts`), which in turn precedes `execute.ts`. The tree below follows that order: Task 4.1 = tag, Task 4.2 = plan, Task 4.3 = execute.

```
Phase 4 — Organize
│
├─ Task 4.1 — Tag the COPY  [commits TrackTags — must precede plan.ts/execute.ts (R5)]
│   │  Capability: stamp corrected metadata onto a single file in place via node-taglib-sharp — the caller
│   │  MUST point it at a COPY, never a source. Commits the TrackTags type its consumers (plan.ts, execute.ts) import.
│   │  Maps to: src/engine/organize/tag.ts (ONE real file). Depends on: nothing in P4 (it is the R5 anchor that commits TrackTags); node-taglib-sharp (locked write dep).
│   │
│   └─ Subtask 4.1.1 — src/engine/organize/tag.ts   [R5: commits TrackTags BEFORE plan.ts/execute.ts import it]
│        Responsibility: stamp corrected metadata onto a single file in place via node-taglib-sharp — the caller MUST point it at a COPY, never a source.
│        Imports: `File` from node-taglib-sharp.   Exports: interface `TrackTags`, function `writeTrackTags(path, tags)`.
│        Invariants bound: (I1) writes in place and is contractually only ever aimed at the destination copy — never a source file; (I2) pure engine, no http/Electron/DOM (taglib is a metadata lib, the locked write dep per I5); (I5) node-taglib-sharp is the locked writer, TS-strict.
│        Test: no dedicated test exercises the write path; correctness is proven by `npm run typecheck` over the `TrackTags` contract. (test/execute.test.ts invokes the organize pipeline only with empty `tags: {}`, so it does not exercise the metadata stamp.)
│        Gate: `npm run typecheck` (+ `npm test -- execute`, which compiles/links tag.ts via execute.ts).
│
├─ Task 4.2 — Plan the clean tree
│   │  Capability: turn reconstructed AlbumCandidate[] into an OrganizePlan of source→dest copy actions.
│   │  Maps to: src/engine/organize/plan.ts (ONE real file — the planner). Depends on: Task 4.1 tag.ts (type TrackTags only), types.ts + text.ts (P1).
│   │
│   └─ Subtask 4.2.1 — src/engine/organize/plan.ts
│        Responsibility: produce a dry-run-pure OrganizePlan mapping each source TrackSlot to a sanitized destination path under destRoot, never touching any source file.
│        Details: sanitizeSegment makes cross-platform-safe segment names; template/preset render via ORGANIZE_PRESETS; multi-disc gets an auto "Disc N" folder even when the template omits {disc}; passed-in AlbumEnrichment can remap a collapsed single disc; over-long paths and below-minConfidence candidates are skipped; collisions are recorded; re-planning the same input is idempotent.
│        Imports: types `AlbumCandidate, DiscGroup, TrackSlot` from ../types.js; `extOf, normalize` from ../text.js; type `TrackTags` from ./tag.js.   Exports: `sanitizeSegment`, `ORGANIZE_PRESETS`, `planOrganize`, and the interfaces `AlbumEnrichment`, `OrganizeOptions`, `OrganizeAction`, `OrganizePlan`.
│        Invariants bound: (I1) emits only source→dest *plans* — zero filesystem writes, source untouched; (I2) pure, no http/Electron/DOM; (I3) offline — enrichment is an optional passed-in Map, never fetched here; (I4) `minConfidence` honours the ≤0.75 reconstruction cap; (I5) TS-strict + noUncheckedIndexedAccess.
│        Test: test/organize.test.ts (6) — sanitizeSegment strips illegal/reserved/trailing-dot names; preset templates render & collapse empty {year}/{disc}; collisions are detected; re-planning the same input is idempotent. test/organize-multidisc.test.ts (8) — multi-disc gets a "Disc N" folder even when the template omits {disc}; enrichment tracklist remaps a collapsed single disc; reset-detection splits when no tracklist.
│        Gate: `npm test -- organize` (6 + 8) + `npm run typecheck`.
│
├─ Task 4.3 — Copy · verify · publish
│   │  Capability: execute a plan — copy each source to a unique temp (single hashing read), verify the
│   │  landed bytes by sha256, fsync, optionally tag-the-copy, then atomically publish.
│   │  Maps to: src/engine/organize/execute.ts (ONE real file). Depends on: Task 4.2 plan.ts (OrganizePlan/OrganizeAction), Task 4.1 tag.ts (writeTrackTags), text.ts (P1).
│   │
│   └─ Subtask 4.3.1 — src/engine/organize/execute.ts
│        Responsibility: atomically publish each plan action by copying to a verified temp (sha256-checked, fsynced, optionally tagged) then renaming into place, never reading or mutating the source more than once.
│        Guarantees (separate from the responsibility): skip-if-exists (idempotent), fail-on-collision, honour dry-run (writes nothing), and HALT if destRoot overlaps the source tree.
│        Imports: `createHash, randomUUID` from node:crypto; `createReadStream, createWriteStream` from node:fs; `mkdir, rename, stat, rm, open` from node:fs/promises; `dirname, basename, join, resolve, relative, isAbsolute` from node:path; `Transform` from node:stream; `pipeline` from node:stream/promises; types `OrganizePlan, OrganizeAction` from ./plan.js; `writeTrackTags` from ./tag.js; `isAudioExt, extOf` from ../text.js.   Exports: interfaces `ExecuteOptions`, `ActionResult`, `ExecuteReport`, function `executePlan(plan, opts)`.
│        Invariants bound: (I1) THE load-bearing HALT — source is only ever READ (hash computed on the copy-stream, no second source read, no rename/truncate/delete) and `executePlan` throws if destRoot overlaps sourceRoot, so source checksum is identical before/after; (I2) pure engine, Node fs only — no http/Electron/DOM; (I3) offline — pure local filesystem copy; (I5) TS-strict.
│        Test: test/execute.test.ts (4) — copy lands byte-identical (sourceHash == copyHash) and the SOURCE checksum is unchanged after; existing destination is skipped (idempotent); a destination overlapping the source tree throws the HALT; dry-run writes nothing.
│        Gate: `npm test -- execute` (4) + `npm run typecheck`.
│
└─ Task 4.4 — CLI: reconstruct → plan → dry-run | execute
    │  Capability: wire the organize subcommand into the sommelier bin — reconstruct a collection, planOrganize
    │  it, then either preview (dry-run) or executePlan, all through the engine barrel only.
    │  Maps to: src/cli/index.ts (the ONE real composition root; the organize subcommand within it). Depends on: plan.ts + execute.ts (re-exported through src/engine/index.js).
    │
    └─ Subtask 4.4.1 — src/cli/index.ts (organize subcommand)   [SAME leaf as 3.5.1 — extends it; full definition at 3.5.1]
         Responsibility: the `organize` subcommand — read inventory, `reconstruct` it, `planOrganize` with the chosen preset/destRoot, then print the plan (dry-run default) or call `executePlan` to copy-verify-tag, surfacing collisions/skips/HALT to the user.
         Imports: from ../engine/index.js ONLY (the barrel re-exports `planOrganize`, `ORGANIZE_PRESETS`, `executePlan`, plus reconstruct/inventory) — composition root touches no engine internals directly.   Exports: the `sommelier` bin entrypoint (no module exports; side-effecting CLI).
         Invariants bound: (I1) defaults to dry-run / preview and only writes via executePlan into a dest OUTSIDE the source — source stays read-only; (I2) CLI lives outside src/engine and imports the pure engine verbatim through the barrel; (I3) offline — reconstruct→plan→execute need zero network; (I4) any confidence gating passed through honours the ≤0.75 cap.
         Test: no dedicated unit test (thin composition root); proven end-to-end by the Phase exit gate plus the `reconstruct:sample` script exercising the same barrel; the organize engine itself is covered by test/organize.* and test/execute.test.ts.
         Gate: `npm test -- organize` (6 + 8) + `npm test -- execute` (4) + `npm run typecheck`; source checksum identical before/after (I1).
```

---

### Phase 5 — Insights

**Milestone:** collection facts + HONEST owner profiling that derives an acquisition timeline ONLY where year evidence is reliable, and WITHHOLDS/flags it otherwise; plus a self-contained offline static HTML report and the CLI to emit both.
**Exit gate:** `npm test -- insights` (6 green) + `npm run typecheck`; honesty assertion holds (low-confidence timeline claims omitted or flagged).

```
Phase 5 — Insights
│
├─ Task 5.1 — Collection facts
│    Capability: compute hard counts/ratios about the collection (releases, tracks, bytes, avg track MB, lossless ratio, format histogram, avg tracks/release, multi-disc, orphans, compilation ratio, numbered ratio, known-year ratio, decade histogram, top artists).
│    Maps to: src/engine/insights/insights.ts (the CollectionInsights half of computeInsights). Depends on: P1 types.ts + text.ts; P3 reconstruct.ts (consumes its ReconstructionReport).
│
├─ Task 5.2 — Honest owner profile
│    Capability: derive owner signals (build-history reliability, classic-vs-new era split, archetypes, supporting signals) — gating the acquisition timeline behind a single-import-day collapse check and gating era split behind a known-year threshold, withholding/flagging whatever the evidence can't support.
│    Maps to: src/engine/insights/insights.ts (the OwnerProfile/OwnerSignal half — internal profileOwner + the exported interfaces). Depends on: Task 5.1 (same file; reuses audio set + byDate + knownYear computed there). Two tasks → ONE real leaf (R3).
│  │
│  └─ Subtask 5.1+5.2.1 — src/engine/insights/insights.ts   [the ONE real leaf for Tasks 5.1 and 5.2]
│       Responsibility: 100%-local computeInsights producing one InsightsReport that co-locates two stages — (a) the CollectionInsights counts/ratios/decade-histogram/top-artists, and (b) the honesty-gated OwnerProfile.
│       Stages (co-located in this one leaf): (a) CollectionInsights = hard counts/ratios; (b) OwnerProfile = owner signals whose acquisition timeline is GATED behind a bulk-import collapse check and whose era split is GATED behind a known-year ratio, every inference carrying a confidence + plain-language "why", unreliable timelines WITHHELD.
│       Imports: `../types.js` (type AlbumCandidate, MediaFileRecord, ReconstructionReport), `../text.js` (isAudioExt, isLosslessExt).   Exports: interface CollectionInsights, interface OwnerSignal, interface OwnerProfile, interface InsightsReport, function computeInsights.
│       Invariants bound: (I2) pure — zero http/Electron/DOM imports; (I3) offline — nothing leaves the machine; (I4) honesty — buildHistory.reliable requires ≥5 distinct days AND top-date share <0.6 else timeline withheld, classicVsNew.computable requires known-year ratio ≥0.5 else flagged not-computable, every OwnerSignal.confidence ≤0.85; (I5) TS-strict + noUncheckedIndexedAccess.
│       Test: test/insights.test.ts — single-import-day fixture ⇒ buildHistory.reliable === false with a "bulk copy" reason (timeline withheld); sparse-year fixture ⇒ classicVsNew.computable === false; counts/ratios (releases, lossless, decadeHistogram, topArtists) match the fixture. (6 cases)
│       Gate: `npm test -- insights` (6) + `npm run typecheck`.
│
├─ Task 5.3 — Static report
│    Capability: render a reconstructed library as one self-contained, offline, safe-escaped static HTML page (KPI header, per-album confidence-coded collapsible cards with evidence/flags/track tables, duplicate-candidates section).
│    Maps to: src/engine/report/html.ts. Depends on: P1 types.ts + text.ts; P3 reconstruct.ts (consumes its ReconstructionReport).
│  │
│  └─ Subtask 5.3.1 — src/engine/report/html.ts
│       Responsibility: turn a ReconstructionReport into a single self-contained HTML string — inline CSS, no external assets, all dynamic content HTML-escaped, with confidence-class-coded album cards and a duplicates section.
│       Imports: `../types.js` (type AlbumCandidate, ReconstructionReport), `../text.js` (humanBytes).   Exports: function renderHtml (internal helpers esc, confClass, card are file-private).
│       Invariants bound: (I1) read-only/COPY-safe — emits a string, never touches source files; (I2) pure — zero http/Electron/DOM-runtime imports (produces HTML text, does not run it); (I3) offline — no external assets/fonts/scripts, fully self-contained; (I4) surfaces each candidate's confidence (≤0.75) and "why grouped" evidence trace verbatim; (I5) TS-strict + noUncheckedIndexedAccess.
│       Test: covered by the insights gate / report smoke — renderHtml(report) returns a `<!doctype html>` string, escapes `&<>"'`, and confClass maps 0.6/0.4 thresholds to hi/mid/lo. (within the insights suite)
│       Gate: `npm run typecheck` (+ `npm test -- insights`).
│
└─ Task 5.4 — CLI surface
     Capability: expose the insights + report engine through the sommelier bin — the `insights` subcommand prints
       collection facts/owner profile, and the static HTML report is produced via the `--html out.html` flag on the
       `reconstruct` subcommand (read fixture/listing → reconstruct → computeInsights / renderHtml → stdout or COPY-tree HTML).
     Maps to: src/cli/index.ts (insights subcommand + the reconstruct `--html` flag). Depends on: Task 5.1+5.2 (computeInsights) and Task 5.3 (renderHtml), reached ONLY via the engine barrel src/engine/index.js.
   │
   └─ Subtask 5.4.1 — src/cli/index.ts (insights subcommand + reconstruct --html)   [SAME leaf as 3.5.1 — extends it; full definition at 3.5.1]
        Responsibility: composition-root surfacing — the `insights` subcommand loads a listing/walk, runs reconstruct, then prints computeInsights facts; the static HTML report is written via `sommelier reconstruct <input> --html out.html` (the `--html` flag on the reconstruct command, NOT a separate `report` subcommand) calling renderHtml — wiring engine outputs to the terminal/COPY tree without embedding any engine logic.
        Imports: `../engine/index.js` ONLY (the public barrel re-exporting computeInsights, renderHtml, reconstruct, and their types).   Exports: the `sommelier` bin entry (no engine exports; CLI is a leaf consumer).
        Invariants bound: (I1) writes only to the COPY tree (HTML output), never mutates source; (I2) keeps engine pure — CLI is the ONLY layer allowed I/O, imports engine via the barrel exclusively; (I3) offline — insights/report run with zero network; (I4) passes through engine confidence/evidence unchanged.
        Test: exercised via `npm run cli` / `reconstruct:sample`-style invocation (`reconstruct <input> --html out.html` for the report path); engine correctness is proven by the engine suites (no separate CLI unit test).
        Gate: `npm test -- insights` (6) + `npm run typecheck` (whole-tree compile of the bin).
```

---

## (D) Build Order

Every distinct leaf, in the exact dependency sequence to implement it. Each line names its path, key export(s), and gate. Shared types/helpers first; the barrel created early then append-extended; inventory before reconstruct; reconstruct before organize/insights; CLI last (one real file, grown command-by-command).

1. **`package.json`** — declare `type=module`, the `sommelier` bin (→ `dist/cli/index.js`), the locked deps (better-sqlite3, music-metadata, node-taglib-sharp, exifr, ffmpeg-static, ffprobe-static; devDeps tsx, typescript, vitest), and the gate scripts (`build`, `typecheck`, `test`, `cli`, `reconstruct:sample`). **Gate:** `npm run typecheck` (script resolves) + `npm test -- text` (script resolves).
2. **`tsconfig.json`** — enforce TS strict + `noUncheckedIndexedAccess` under NodeNext module/resolution so `.js`-suffixed ESM specifiers compile. **Gate:** `npm run typecheck`.
3. **`src/engine/types.ts`** — commit the whole import-free domain type ledger: export `MediaType, MediaFileRecord, ParsedName, DiscGroup, TrackSlot, CandidateFlag, AlbumCandidate, DuplicateCandidate, ReconstructionReport` (confidence typed 0..0.75 with an `evidence:string[]` trace). **Gate:** `npm run typecheck`.
4. **`src/engine/text.ts`** — implement the pure, zero-import string toolkit: export `isAudioExt, isLosslessExt, mediaTypeForExt, extOf, basename, stem, normalize, stripDiscTokens, titleKey, findYear, humanBytes, plausibleDurationMs`. **Gate:** `npm test -- text` (21) + `npm run typecheck`.
5. **`src/engine/index.ts`** — create the public barrel; re-export the type ledger (from `./types.js`) and the text helpers (from `./text.js`). This file is APPEND-EXTENDED by every later phase. **Gate:** `npm run typecheck`.
6. **`test/fixtures/sample/sample-collection.dir.txt`** — author the deliberately messy committed Windows `dir /s` listing (sibling multi-disc folders, orphan singles, no-track-number sets, mixed naming schemes, compilations). Read-only input, parsed via `--from-listing`. **Gate:** `npm run reconstruct:sample` (the fixture loads/parses).
7. **`src/engine/inventory/dirListing.ts`** — parse a `dir /s` text dump into `MediaFileRecord[]` with zero disk touch; import `MediaFileRecord` from `../types.js` and `extOf, mediaTypeForExt` from `../text.js`; export `parseDirListing`. **Gate:** `npm run reconstruct:sample` (expected audio record count) + `npm run typecheck`.
8. **`src/engine/inventory/walk.ts`** — async, bounded, symlink-cycle-guarded fs traversal emitting the same `MediaFileRecord` shape, plus a drive-appearance poller; import from `node:fs/promises`/`node:path` + `../types.js`/`../text.js`; export `WalkOptions, walk, walkToArray, WaitOptions, waitForPath`. **Gate:** `npm test -- wait` (2) + `npm run typecheck`.
9. **`src/engine/inventory/tags.ts`** — READ embedded tags/audio properties from one real file via `music-metadata`, normalized to `TagInfo` (empty on unreadable); import `parseFile` from `music-metadata`; export `TagInfo, readTags`. **Gate:** `npm run typecheck`.
10. **`src/engine/inventory/cover.ts`** — resolve cover art (embedded picture, else folder image, else null); import `parseFile` from `music-metadata` + `node:fs`/`node:fs/promises`/`node:path`; export `Cover, readCover`. **Gate:** `npm run typecheck`.
11. **`src/engine/reconstruct/parseName.ts`** — map one filename to `ParsedName` via ordered scheme matchers (numbers first, best-effort artist/title); import `ParsedName` from `../types.js` and `stem` from `../text.js`; export `parseName`. **Gate:** `npm test -- reconstruct` (14 + 6) + `npm run typecheck`.
12. **`src/engine/reconstruct/reconstruct.ts`** — the single offline pass doing grouping + multi-disc merge + artist attribution + confidence(≤0.75)/evidence/flags + duplicates + summary; import from `../types.js`, `../text.js`, `./parseName.js`; export `reconstruct` (re-export `humanBytes`). Then APPEND a reconstruct re-export block to `src/engine/index.ts`. **Gate:** `npm test -- reconstruct` (14 + 6) + `npm run typecheck`.
13. **`src/engine/organize/tag.ts`** — (R5: commits `TrackTags` before its consumers) stamp metadata in place on a COPY via `node-taglib-sharp`; import `File` from `node-taglib-sharp`; export interface `TrackTags` and `writeTrackTags(path, tags)`. **Gate:** `npm run typecheck` (+ `npm test -- execute`, which links tag.ts via execute.ts).
14. **`src/engine/organize/plan.ts`** — produce a dry-run-pure `OrganizePlan` (sanitized dest paths, preset/template render, auto "Disc N" folder, enrichment remap, collision/skip detection, idempotent); import `AlbumCandidate, DiscGroup, TrackSlot` from `../types.js`, `extOf, normalize` from `../text.js`, type `TrackTags` from `./tag.js`; export `sanitizeSegment, ORGANIZE_PRESETS, planOrganize` and `AlbumEnrichment, OrganizeOptions, OrganizeAction, OrganizePlan`. Then APPEND an organize re-export block to `src/engine/index.ts`. **Gate:** `npm test -- organize` (6 + 8) + `npm run typecheck`.
15. **`src/engine/organize/execute.ts`** — copy each action to a unique temp while hashing (one source read), verify sha256, fsync, optionally tag the temp, atomically rename; skip-existing, fail-on-collision, dry-run, HALT if dest overlaps source; import `node:crypto`/`node:fs`/`node:fs/promises`/`node:path`/`node:stream`(+promises), `OrganizePlan, OrganizeAction` from `./plan.js`, `writeTrackTags` from `./tag.js`, `isAudioExt, extOf` from `../text.js`; export `ExecuteOptions, ActionResult, ExecuteReport, executePlan`. Then APPEND its re-export to `src/engine/index.ts`. **Gate:** `npm test -- execute` (4) + `npm run typecheck`; source checksum identical before/after (I1).
16. **`src/engine/insights/insights.ts`** — 100%-local `computeInsights` building `CollectionInsights` + an honesty-gated `OwnerProfile` (timeline withheld unless ≥5 distinct days & top-date share <0.6; era split gated behind known-year ratio ≥0.5; every signal confidence ≤0.85); import `AlbumCandidate, MediaFileRecord, ReconstructionReport` from `../types.js` and `isAudioExt, isLosslessExt` from `../text.js`; export `CollectionInsights, OwnerSignal, OwnerProfile, InsightsReport, computeInsights`. Then APPEND an insights re-export block to `src/engine/index.ts`. **Gate:** `npm test -- insights` (6) + `npm run typecheck`.
17. **`src/engine/report/html.ts`** — turn a `ReconstructionReport` into one self-contained, fully-escaped, offline HTML string (KPI header, confidence-coded cards with evidence/flags, duplicates section); import `AlbumCandidate, ReconstructionReport` from `../types.js` and `humanBytes` from `../text.js`; export `renderHtml`. Then APPEND a report re-export block to `src/engine/index.ts`. **Gate:** `npm run typecheck` (+ `npm test -- insights`).
18. **`src/cli/index.ts`** — the single `sommelier` composition-root bin, importing `../engine/index.js` ONLY (+ `node:fs`/`node:fs/promises`). Build it command-by-command in dependency order: first the **`reconstruct`** subcommand (load inventory via `parseDirListing`/`walkToArray`, run `reconstruct`, render human/JSON, write static HTML via `--html out.html` — gate `npm run reconstruct:sample`, no source touched, confidence ≤0.75); then the **`organize`** subcommand (reconstruct → `planOrganize` → dry-run preview or `executePlan` — gate `npm test -- organize` + `npm test -- execute`, source checksum unchanged); then the **`insights`** subcommand (reconstruct → `computeInsights` to stdout — gate `npm test -- insights`). **Final gate:** `npm run reconstruct:sample` + `npm test -- organize` + `npm test -- execute` + `npm test -- insights` + `npm run typecheck`.

---

### Notes on tree-vs-reality

- **P3 reconstruction is one file, not five.** The exercise asks to split grouping / multi-disc merge / artist attribution / confidence+evidence into separate leaves, but the shipped repo co-locates all four as internal stages of `src/engine/reconstruct/reconstruct.ts`. They are presented as Tasks resolving to that one real leaf rather than inventing `group.ts`/`multidisc.ts` files — which also satisfies rule R3 ("fewer well-bounded children"). Splitting them into separate one-sitting files is a real (optional) refactor, not the current state.
- **The CLI is one shared leaf across P3/P4/P5.** `src/cli/index.ts` is defined once at 3.5.1 and *extended* (not duplicated) by the organize and insights subcommands — the build order grows it command-by-command at step 18.

> This document is the pedagogical "how to build it" companion to [STATUS.md](../STATUS.md), which tracks the actual `done`/`todo` state of the same tree. The repo's own phase numbering (P0–P8) differs: this build tree's P1 maps to repo P0 + scaffolding; P2→P1; P3→P2; P4→P3; P5→P5. See STATUS.md for the full architectural-layer phases and the F1–F6 frontier.
