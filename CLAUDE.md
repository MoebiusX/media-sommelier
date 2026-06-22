# CLAUDE.md — operating manual for agents

> The portable, in-repo guide every agent reads first. (User-local memory under `~/.claude` is **not**
> visible to other agent types, fresh clones, or CI — this file is.) Canonical for both Claude Code
> (`CLAUDE.md`) and other harnesses ([AGENTS.md](AGENTS.md) points here).

## What this is

**Media Sommelier** reconstructs a scattered, mistagged music collection into real albums and copies them
into a clean tree — **originals are never mutated**. A pure TypeScript engine, a CLI, and a local web app
(HTTP API + React UI) all run the same engine.

## Orientation order (read these, in order)

1. **This file** — rules, commands, invariants.
2. **[STATUS.md](STATUS.md)** — the LIVE build state: the `Phase → Task → Leaf` tree with per-node gate
   state, what's done, what's next. This is the **handoff baton** — read it to resume, update it when you finish.
3. **[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)** (intent/design) and
   **[docs/BUILD_TREE.md](docs/BUILD_TREE.md)** (leaf-level decomposition of the shipped engine).

## Commands

| Task | Command |
|---|---|
| Install (root + web) | `npm install` · `npm --prefix web install` |
| Typecheck | `npm run typecheck` |
| Test (all / one) | `npm test` · `npm test -- <name>` |
| Build (engine+CLI / web) | `npm run build` · `npm run build:web` |
| Run CLI | `npm run cli -- <args>` · sample: `npm run reconstruct:sample` |
| Dev app (api 4178 + web 5180) | `npm run dev` |

## Invariants — load-bearing, NEVER violate

- **I1 — Source is READ-ONLY.** The only writes anywhere are SQLite under `data/` and the organized COPY
  tree. Never rename/move/delete/retag a *source* file.
- **I2 — Pure engine.** `src/engine/**` has ZERO http/Electron/DOM imports. CLI, tests, and `server2` reuse it verbatim.
- **I3 — Offline-first.** Reconstruction works with zero network. Enrichment (`src/engine/enrich/**`) is an
  optional, graceful-degrade layer — never on the core reconstruction path.
- **I4 — Confidence cap.** Offline reconstruction confidence is hard-capped **≤ 0.75**; every grouping
  carries an `evidence: string[]` "why grouped" trace.
- **I5 — Stack is locked.** TS strict + `noUncheckedIndexedAccess`, Node ≥ 22, ESM/NodeNext (use `.js`
  import suffixes even from `.ts`), `tsx` + `vitest`. **No new dependencies without asking.**

## Repo map

- `src/engine/**` — the pure engine. `types.ts` (domain ledger) + `text.ts` (helpers) + `inventory/`,
  `reconstruct/`, `organize/`, `library/`, `insights/`, `report/`, `enrich/`. Public API via the
  `src/engine/index.ts` barrel.
- `src/cli/index.ts` — the `sommelier` CLI; imports `../engine/index.js` **only**.
- `src/server2/**` — local HTTP API + SQLite catalog (the app backend). May import the engine barrel; never engine internals.
- `web/**` — React UI. Talks to `server2` over HTTP; **no engine import in the browser.**
- `test/**` — vitest suites. `test/fixtures/sample/sample-collection.dir.txt` is the deliberately messy fixture.
- `docs/**` — plan, decomposition, design.

## Gates — run before you hand off, mark a node done, or commit

A node is **done only when its named gate ran green** — never on inspection.

- Engine / CLI change → `npm run typecheck && npm test` (+ `npm run reconstruct:sample` for reconstruct changes)
- Web change → `npm run build:web`
- Everything → `npm run typecheck && npm test && npm run build:web`

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs these on every push/PR. If
`.claude/settings.json` defines a `PostToolUse` typecheck hook, you also get fast type feedback after each edit.

## Handoff protocol (sequential agents)

When you finish a unit of work: update **STATUS.md** (node state + the "last verification" line) so the
next agent resumes without re-deriving the plan. Don't commit or push unless asked; if you're on `main`, branch first.

## Specialized agents

Role-scoped definitions live in [.claude/agents/](.claude/agents/): **engine-dev** (`src/engine`+`src/cli`),
**web-dev** (`web`+`src/server2`), **reviewer** (read-only invariant audit). Each restates the invariants for its lane.

## Don'ts

Don't write to source files (I1) · don't add http/DOM imports under `src/engine` (I2) · don't put network
on the core reconstruct path (I3) · don't let offline confidence exceed 0.75 (I4) · don't add dependencies
without asking (I5).
