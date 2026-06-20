# V0 Goal (autonomous build session)

**Mission:** Ship a working, *tested* Media Sommelier V0 engine that reconstructs albums from a media
inventory and proves it on the real `Y:\Car Playlists\Selection` sample — pure-TypeScript, decoupled
from any UI, runnable via CLI.

This is the "smallest lovable slice" from the plan ([docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) §9 Phase V0),
built engine-first because the engine is the unproven bet and the most testable part.

## Definition of done (V0)

- [ ] TypeScript toolchain: build (`tsc`), test (`vitest`), run (`tsx`), typecheck — all green
- [ ] Engine types (`MediaFile`, `AlbumCandidate`, discs, evidence, confidence)
- [ ] Inventory sources:
  - [ ] **dir-listing importer** (parses Windows `dir /s` → records) — lets us run on the REAL sample now
  - [ ] **filesystem walker** (for real runs on a machine with the drive mounted; tag read via music-metadata, lazy)
- [ ] Filename/naming-scheme parser + normalization (handles the 5 schemes in the sample)
- [ ] **Offline reconstruction** (the corrected algorithm from the plan):
  - [ ] folder-cohesion clustering
  - [ ] multi-disc merge — inline-marker stems (Pink Floyd Echoes Cd1/Cd2), dedicated-parent siblings (Queen GH I/II/III, Supertramp vol1/2), in-folder disc prefixes (Led Zeppelin 1xx/2xx)
  - [ ] track-order inference + completeness estimate
  - [ ] orphan + cross-album duplicate detection
  - [ ] confidence (offline-capped) + human-readable evidence trace
- [ ] **Organize planner**: path template + dry-run copy plan (no source mutation; copy not executed in V0)
- [ ] **CLI**: `reconstruct <listing|dir>` and `plan` → pretty + `--json` output
- [ ] **Tests** asserting real-sample outcomes (Echoes→1 release/2 discs/26 tracks; Supertramp merged; Queen 3-disc box; orphans; dup candidates)
- [ ] `STATUS.md` running log for review

## Stretch (if time)
- [ ] Execute copy to a temp dest with blake3-style verify (synthetic files only)
- [ ] Static HTML report of reconstructed albums
- [ ] Minimal Electron shell stub wiring the engine

## Guardrails
- Engine has ZERO UI/Electron imports. Source files always read-only. Commit incrementally.
