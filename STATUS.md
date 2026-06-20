# STATUS — autonomous V0 build

_Running log so we can review on your return. Newest first._

## ▶ Review summary (read me first)

**A complete, tested V0 of the engine is built and committed** — the whole pipeline works end-to-end on
your real `Selection` data: **scan → reconstruct albums → organize (copy, verified) → insights + owner
profile**. 21 tests green, `tsc` clean, 6 commits on `main`. Open `docs/sample-report.html` in a browser
to see the reconstruction; run the CLI commands in `README.md` to drive it.

I **stopped here on purpose** rather than spin into the next phase unattended, because the next steps
either need your decision or can't be verified without your real files:

1. **Commercial vs non-commercial** — gates the whole enrichment stack (MusicBrainz/AcoustID/Discogs
   licensing). V1 (fingerprinting + online matching, which fixes typo'd titles and recovers the
   orphaned Eagles/Marc-Antoine albums) is blocked on this. *Recommended: non-commercial/personal.*
2. **Run it on the real drive** — I can't reach `Y:\` from here, so I validated via the `dir` listing.
   The `fs` walker is built + integration-tested; pointing it at `Y:\Car Playlists` is the real dogfood.
3. **Desktop shell (Electron)** — deferred; building/verifying a GUI unattended risks a broken state.

Say "keep going" + answer #1 and I'll start V1; or we review together.

---

## ✅ Milestone 3 — collection insights + owner profiling (your original vision)

The "tell me interesting things about the collection and its owner" feature, V0. Run it:
```bash
npx tsx src/cli/index.ts insights test/fixtures/real-world/car-playlists-selection.dir.txt --from-listing
```
On your sample it produces:
- **Collection:** 0% lossless (all MP3), 50% compilations, 63% releases numbered, 3 multi-disc, 2 orphans, top artists by track count, ~8.9 MB/track.
- **Owner archetypes (ranked, with confidence + why):** "Convenience over fidelity" [0.80], "Curated/casual listener (greatest-hits driven)" [0.75], "Sampler, not a completionist" [0.60].
- **Honest gating (the review's key demand):** build-history timeline **withheld** — "99% of files share one date (2024-10-30) → bulk copy, timestamps aren't real acquisition"; classic-vs-new **declined** — "release year known for only 13% of releases, needs V1 enrichment". This is the plan's "lead with survivable signals, gate the rest" principle, working.

`src/engine/insights/insights.ts` + CLI `insights` + 5 tests. 100% local; nothing leaves the machine.

## ✅ Milestone 2 — copy execution (verified) + HTML report + organize CLI

- **Copy executor** (`src/engine/organize/execute.ts`): copies into the new tree via temp-file +
  atomic rename, **re-hashes every copy and asserts it matches the source**, idempotent/resumable
  (identical destinations skipped). Source is only ever read.
- **fs walk → reconstruct → plan → execute integration test**: synthesizes a scattered album on a
  real temp filesystem, runs the whole pipeline, asserts copies are hash-verified, **originals
  unchanged**, and re-runs are idempotent (5 copied → 0 copied/5 skipped). This also proves the real
  `fs` walker, not just the listing import.
- **HTML report** (`src/engine/report/html.ts`): self-contained dark-mode page of reconstructed
  releases (confidence colors, flags, collapsible disc/track tree). Generated sample committed at
  [`docs/sample-report.html`](docs/sample-report.html) — open it in a browser.
- **CLI `organize`** command: dry-run by default, `--execute` to copy; `reconstruct --html <file>`.
- **15 tests** total, `tsc --noEmit` clean.

## ✅ Milestone 1 — engine vertical slice works end-to-end on your real data

The whole V0 spine is built, typechecked, tested, and **proven on your `Y:\Car Playlists\Selection`
sample** (imported via the committed `dir` listing — I can't reach `Y:\` from here, so the listing is
the live test input; the real `fs` walker is built and ready for when it runs on your machine).

**Try it yourself:**
```bash
cd media-sommelier
npm install
npm run reconstruct:sample          # reconstruct the real sample, pretty output
npx tsx src/cli/index.ts plan test/fixtures/real-world/car-playlists-selection.dir.txt --from-listing --dest "D:/Organized"
npm test                            # 13 tests, all green
```

**What it correctly did with your messy data (the whole point):**
| Your folder mess | What the engine produced |
|---|---|
| `Pink Floyd - Echoes Cd 1` + `Cd 2` (2 sibling folders) | **1 release "Echoes", 2 discs, 26 tracks** (merged) |
| `Greatest Hits I` / `II` / `III` (dedicated-parent box) | **1 Queen box, 3 discs, 51 tracks** (merged) |
| `Supertramp …(volume1)` + `(volume2)` | **1 release, 29 tracks**, flagged `no-track-numbers` |
| `…(Remasters 2CD)\CD 2` only | **Led Zeppelin, disc 2**, flagged `partial-disc-set`, year 2007 |
| `Marc Antoine\Mediterraneo`, `The Eagles\Top 100` | flagged `orphan` (1 track each) |
| 5 naming schemes | parsed per-scheme; `led_zeppelin` → "Led Zeppelin" |

8 releases from 146 files, 3 multi-disc, 2 orphans, confidence offline-capped ≤0.75, every grouping
carries a human "why grouped" trace. The dry-run organize plan maps all 146 files into a clean
`Artist/Album/Disc N/NN - Title` tree with **zero source mutation**.

**Built:**
- `src/engine/` (pure TS, zero UI imports): `types`, `text`, `inventory/{dirListing,walk}`,
  `reconstruct/{parseName,reconstruct}`, `organize/plan`, `index`
- `src/cli/` — `reconstruct` + `plan` commands (`--from-listing`, `--json`, `--dest`, `--min-confidence`)
- `test/reconstruct.test.ts` — 13 tests asserting the real-sample outcomes above
- Toolchain: TypeScript strict (NodeNext), vitest, tsx; `tsc --noEmit` clean

**Known V0 limitations (by design — deferred per the plan):**
- Reconstruction is **offline/heuristic only** — no fingerprint/MusicBrainz yet (that's V1; it's what
  fixes typo'd titles like `Under Presure` and recovers the orphaned Eagles/Marc-Antoine albums).
- Organize is **dry-run only** — no bytes copied yet (execution + hash-verify is a stretch goal below).
- Tag *reading* during `fs` walk not wired (filenames/folders suffice for V0); tag *writing* not yet.
- `confidence` weights are hand-tuned placeholders, not corpus-calibrated.

## ▶ Next in the loop (stretch goals, in order)
1. Organize **execution** to a temp dest with copy + hash verify (synthetic files only — never your originals).
2. Static **HTML report** of reconstructed albums (shareable, nicer than terminal).
3. `fs`-walker integration test against a generated synthetic tree (proves the real path, not just the listing import).
4. A few more reconstruction edge cases (in-folder 1xx+2xx multi-disc; mixed-scheme folder).

## Commits
- `chore: scaffold …` · `docs: … implementation plan …` · `feat(engine): V0 reconstruction …`
