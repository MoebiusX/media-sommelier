# AGENTS.md

This repo's canonical agent guide is **[CLAUDE.md](CLAUDE.md)** — read it first. This file mirrors the
load-bearing essentials for agent tools that look for `AGENTS.md`; if the two ever disagree, CLAUDE.md wins.

**Project:** Media Sommelier reconstructs a scattered, mistagged music collection into real albums and
copies them into a clean tree — originals are never mutated. Pure TS engine + CLI + local web app.

## Invariants — NEVER violate

- **I1** Source media is READ-ONLY. Only writes: SQLite under `data/` and the organized COPY tree.
- **I2** `src/engine/**` has ZERO http/Electron/DOM imports (pure engine; CLI/tests/server reuse it verbatim).
- **I3** Reconstruction works fully offline; enrichment (`src/engine/enrich/**`) is optional/graceful-degrade.
- **I4** Offline confidence is capped ≤ 0.75; every grouping carries an `evidence[]` "why grouped" trace.
- **I5** TS strict + `noUncheckedIndexedAccess`, Node ≥ 22, ESM/NodeNext (`.js` import suffixes), `tsx`+`vitest`. No new deps without asking.

## Commands & gates

- Install: `npm install` (+ `npm --prefix web install`)
- Typecheck: `npm run typecheck` · Test: `npm test` (`npm test -- <name>`) · Build web: `npm run build:web`
- CLI: `npm run cli -- <args>` · sample run: `npm run reconstruct:sample`
- **Gate before handoff/commit:** `npm run typecheck && npm test` (+ `npm run build:web` for web changes).
  A node is "done" only when its named gate ran green.

## State & handoff

**[STATUS.md](STATUS.md)** is the live build state and the handoff baton — read it to resume, update it when
you finish a tracked node. Don't commit/push unless asked; branch first if on `main`.
