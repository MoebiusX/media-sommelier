# E2E — Playwright UI suite

End-to-end tests that drive the **real** web app (React UI + `src/server2` API + engine) in a browser and
verify all UI functionality. The suite is designed to be reproducible and to **never touch the user's real
library** (`data/sommelier.db`): it runs against an isolated, seeded catalog under `e2e/.tmp/`.

## Run it

```bash
# stop `npm run dev` first — the suite needs ports 4178 (API) and 5180 (web) free
npm run test:e2e            # headless, all specs
npm run test:e2e:headed     # watch it drive a real browser
npm run test:e2e:ui         # Playwright UI mode (pick/inspect tests)
npm run test:e2e:report     # open the last HTML report
```

`playwright test` starts both servers itself (see `playwright.config.ts` → `webServer`):

- **API** (`npm run e2e:api`) = `tsx e2e/seed.ts && tsx src/server2/index.ts`, pointed at an ephemeral DB via
  `SOMMELIER_DB=e2e/.tmp/sommelier-e2e.db` and `PORT=4178`. The seed runs **before** the server every time, so
  each run starts from a known state.
- **Web** = the Vite dev server on `:5180`, which proxies `/api` → `:4178`.

First-time setup (already done if `npm install` + browser download ran):

```bash
npm install                    # installs @playwright/test (root devDependency)
npx playwright install chromium
```

## What gets seeded (`e2e/seed.ts`)

A tiny hand-authored library written directly into SQLite (no scanning) plus real, browser-decodable
silent **WAV** files (15s each, so a clip never ends mid-test) so playback actually works in headless Chromium:

| Album | Artist | Year | Tracks | Notable |
|---|---|---|---|---|
| Debut | The Testers | 2001 | 3 | real cover art (via `album_overrides`) |
| Live Sessions | The Testers | 2003 | 2 | `needs-review`, `no-track-numbers` flags |
| Signals | Ada Lovelace | 2018 | 4 | 2 discs across 2 folders → **integrated** album (metadata sim) |
| Midnight | Blue Quartet | 1999 | 3 | all lossless → **FLAC** badge |
| Road Trip Mix | Various Artists | 2010 | 3 | `possible-compilation` |
| Drift | Echo Chamber | 2020 | 1 | `orphan` |

Totals: **5 artists / 6 albums / 16 tracks**, 5 distinct genres (Auto-DJ moods), and exactly **one duplicate
group** ("Wanderer" — the lossless Debut copy is the keeper, the lossy Live copy is wasted).

The stable facts are mirrored in `e2e/helpers.ts` as the `SEED` constant; specs assert against `SEED`, never
against magic numbers duplicated from the seed.

## Conventions

- **Helpers** (`e2e/helpers.ts`): `gotoApp`, `openTab`, `openPalette`, `deleteAllPlaylists`,
  `deleteAllProfiles`, `currentTheme`, and the `SEED` catalog.
- **Serial** (`workers: 1`): one shared backend + SQLite catalog. Specs that mutate server state
  (playlists, profiles) clean up after themselves in `beforeEach`/`afterEach`.
- **Selector quirk**: artist rows, album cards, playlist rows, and Overview "top" bars are clickable
  `<div>`s (not buttons) — target them by visible text. Real `<button>`s use `getByRole('button', …)`.
- **Determinism for external I/O**: endpoints that reach MusicBrainz / Cover Art Archive / lrclib, or that
  copy files (organize / sync), are intercepted with `page.route()` and fulfilled with canned JSON. Everything
  else runs for real against the seeded DB.
- **Audio**: the seeded WAVs really play; assert on observable UI (PlayerBar title, active track row,
  now-playing card) rather than exact `currentTime`.

## Defects found and fixed

This suite's first full run (110 tests) surfaced 5 real UI defects, each caught because a test asserted the
behavior a user should get rather than the behavior the code happened to produce. All 5 are now fixed; the
tests that caught them run as ordinary passing assertions (see each spec's comment for the before/after):

| Where | Defect | Fix |
|---|---|---|
| `auto-dj.spec.ts` (×4) | The sidebar Auto DJ picker was occluded by main content and unclickable — `.sidebar` is a stacking context (so its ambient-bloom pseudo-element stays behind content), which confined the picker's `position:fixed` backdrop beneath `.main`. | `AutoDjPicker` (`AutoDj.tsx`) now renders via `createPortal(…, document.body)`. |
| `album.spec.ts` | The completeness panel crashed (`data.missing!.slice`) when a matched MusicBrainz payload omitted the `missing` array. | `Library.tsx`'s `CompletenessPanel` now falls back to `data.missing ?? []`. |
| `playlists.spec.ts` | A smart-playlist "Lossless is Yes" rule left at its default stored an empty condition value (`value={c.value \|\| 'true'}` was display-only) and matched *non*-lossless tracks instead. | `Playlists.tsx`'s `save()` now normalizes an empty lossless/format value to what's displayed before submitting. |
| `refresh-batch.spec.ts` (×2) | An errored refresh sweep hid `job.error` entirely; a failed `/api/refresh/candidates` left the panel stuck on "Checking your library…" forever (both errors were swallowed). | `RefreshBatch.tsx` now shows "Sweep stopped early: {error}" in the review queue, and a "Couldn't check your library… Retry" state for a failed candidates load. |
| `library.spec.ts` | The album "Add to playlist" / "Add to profile" menus had no outside-click-to-close handler. | Both now use a shared `useClickOutside` hook (`ui.tsx`). |
