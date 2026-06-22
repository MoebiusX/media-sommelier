# Media Sommelier

A local-first desktop-style app that **reads your scattered music collection, rebuilds it into real
albums, and gives you the tools to play, clean, complete, and sync it** — without ever modifying your
original files.

It does not just list files. It tastes the cellar.

## The problem it solves

Music collections decay. Albums get split across folders, track numbers vanish, the same song shows up
three times under three spellings, and a whole discography gets reduced to one stray hit. Existing tools
either re-tag in place (risky) or organize by filename (garbage in, garbage out).

This is fundamentally an **entity-resolution** problem: take a pile of mistagged/scattered/duplicated
files and reconstruct the real *releases* they belong to — from folder/tag heuristics, with MusicBrainz +
AcoustID fingerprinting to correct and complete them. **Source files are only ever read; the index and
any organized copies are the only things written.**

## Quick start

Requires Node ≥ 22.

```bash
npm install
npm run dev          # starts the API (:4178) + the web app (:5180)
```

Open **<http://localhost:5180>**, point the **Organize** (or **Scan**) box at a music folder, and run a
scan. It walks the folder, reconstructs albums, and indexes everything into a local SQLite catalog
(`data/sommelier.db`) — re-scans are near-instant thanks to a tag cache keyed by path+size+mtime. Then
browse, search (`⌘K`), play, de-dupe, organize, and sync.

Prefer the terminal? Index a folder headless, then start just the web app:

```bash
npm run ingest -- "Y:\"      # walk + reconstruct + index into data/sommelier.db
npm run dev
```

No drive handy? The engine ships a real-data **filename-only** sample (see [the problem in
action](#the-problem-in-action)):

```bash
npm run reconstruct:sample   # rebuild albums from a bundled `dir /s` dump, offline
```

## What it does

The web app is a dark, keyboard-friendly shell over a pure-TypeScript engine. Press **`⌘K` / `Ctrl-K`**
anywhere for a command palette that searches artists, albums and tracks (Enter to open, or play a track).

| Area | What you get |
|---|---|
| **Library** | Browse by **Artists** or **Albums**. The Albums grid sorts (artist / title / newest / most-tracks / largest) and filters by decade. Each album shows reconstructed tracks, a confidence + "why grouped" evidence trace, multi-disc merges, and flags (orphan, no-track-#s, compilation). |
| **Player** | Click any track to play. Bottom transport bar with play/pause, prev/next, seek, volume, **shuffle**, **repeat**, a **queue popover**, and **back-to-album**. Full keyboard control: Space, ←/→ (±5s), Shift+←/→ (prev/next). Streams over HTTP Range so it seeks. |
| **Search** | `⌘K` ranked search across the whole library. |
| **Duplicates** | Finds the same song ripped multiple times and how much space the extras waste; recommends a keeper (lossless > bitrate > size). Read-only — it surfaces them, you decide. |
| **Playlists** | Manual playlists (add a track, or a whole album) **and smart playlists** that fill themselves from rules (genre / artist / format / year / lossless, match all-or-any, sort + limit) and stay current. |
| **Refresh** | Pull canonical title/year + **cover art** from MusicBrainz + the Cover Art Archive — per-album (preview → confirm) or a **library-wide batch** with a review queue. Resumable and cached so re-runs are cheap. |
| **Completeness** | Diff an album against its MusicBrainz tracklist to see which tracks are **missing** (e.g. "you only have CD 1 of this 2-CD set"). |
| **Organize** | Pick a naming scheme + destination, **simulate** schemes to see which fragments least, preview the dry-run plan, then copy into a clean `Artist/YYYY Album/Disc N/NN - Title` tree. Copies are hash-verified; tags written **onto the copies only**. |
| **Sync** | Keep hand-picked **profiles** (Car, Audiobooks, Gym…) mirrored to external drives — additive copy, never deletes. Optional **FLAC→MP3 320k transcoding** for car stereos that can't play lossless. |
| **Overview** | Library stats + a folder-vs-tag reconstruction comparison, plus the cover-refresh and duplicate panels. |

### Safety invariants

- **Source media is never modified.** Scanning only reads; organize/sync only copy; metadata corrections
  live in the SQLite index (durable overrides), and fetched covers cache under `data/` — never written
  back to your files.
- **File-serving is confined.** The audio/cover/image endpoints only serve paths that resolve under a
  scanned root *and* match an indexed track — a stray web page can't use the local server to read
  arbitrary files off your disk.

## Architecture

```
  browser ──/api──▶ Vite dev server (:5180) ──proxy──▶ server2 (:4178, zero-framework Node http)
   React app                                              │
   (web/src)                                              ├── engine (src/engine, pure TS)
                                                          ├── JobService (durable jobs on SQLite)
                                                          └── better-sqlite3 → data/sommelier.db + data/*
```

- **Engine** (`src/engine`) — pure, UI-free TypeScript: inventory walk · reconstruct (album grouping) ·
  enrich (MusicBrainz / AcoustID / Cover Art Archive) · organize (plan → hash-verified copy → tag) ·
  library scan / stats. Reused unchanged by the API.
- **API** (`src/server2`) — a single Node `http` server, localhost-only by default, backed by one SQLite
  database. Long operations (scan, organize, sync, refresh) run through a **JobService** with durable
  state, boot recovery, and a global "what's running" view — see
  [`docs/design/JOBS_AND_ENRICHMENT.md`](docs/design/JOBS_AND_ENRICHMENT.md).
- **Web** (`web/`) — a React + Vite single-page app; `/api` is proxied to `:4178` so both speak one origin.

> **Running under the Claude Code preview harness?** Start the two servers as **separate** launch configs
> (`api` → `npm run dev:api`, `web` → `npm run dev:web`), not the combined `npm run dev` — the harness
> injects one shared `PORT` that both children would otherwise fight over. A normal `npm run dev` is fine.

The legacy single-server UI (`npm run ui`, `src/server`) predates this rewrite and still hosts the
**Photos** and **Videos** browsers (EXIF gallery, on-demand video posters) that the new app doesn't yet
cover; the CLI (`src/cli`) exposes the engine directly.

## Repo layout

```
src/engine/    pure-TS engine: inventory · reconstruct · enrich · organize · library
src/server2/   the app's API — http server, SQLite (db.ts), ingest, JobService (jobs.ts)
web/           React + Vite single-page app (the current UI)
src/server/    legacy single-server UI (photos/videos browsers)
src/cli/       command-line interface over the engine
docs/          architecture, plan, CLI reference, and design docs (design/)
test/          vitest suites (engine + JobService) + the bundled sample fixture
```

## CLI

The engine is also a CLI — handy for headless indexing or scripting. `--from-listing` parses a Windows
`dir /s` dump (how we test on real data without the drive mounted); omit it to walk a real folder.

```bash
LISTING=test/fixtures/sample/sample-collection.dir.txt
npm run cli -- reconstruct "$LISTING" --from-listing                 # rebuild albums (offline)
npm run cli -- insights    "$LISTING" --from-listing                 # collection + owner profile
npm run cli -- enrich      "$LISTING" --limit 8                      # MusicBrainz corrections (network)
npm run cli -- organize    "X:/Music" --dest "D:/Organized" --execute --enrich --write-tags
```

See [`docs/CLI.md`](docs/CLI.md) for all flags and the `.env` setup (AcoustID application key, `fpcalc`).

### The problem in action

A single slice of a real drive shows every failure mode — five naming schemes in one tree, *Pink Floyd –
Echoes* split across two sibling folders, typos that poison tag-only matching (`Bohemian Rapsody`, `Under
Presure`), 71 tracks with no track number, and bulk-copy mtimes that record *when you copied*, not *when
you acquired*. The bundled fixture reproduces it; the generated diagnostic lives in
[`docs/SAMPLE_SCAN.md`](docs/SAMPLE_SCAN.md).

## Design decisions

| Decision | Choice |
|---|---|
| Form factor | Local web app (Vite + React) over a Node API; an Electron shell can host the same page + engine |
| File safety | **Organize/sync into a new tree (copy)** — source files are never mutated |
| Index | A local **SQLite** catalog (`better-sqlite3`); the index is a derived projection, rebuilt by a scan |
| Enrichment | MusicBrainz + Cover Art Archive (no key) with an AcoustID fingerprint fallback (key + `fpcalc`); cached + rate-limited, offline-graceful |
| Media types | Music (the focus); photos/videos in the legacy UI |

## Status

Working end-to-end and tested — **101 vitest tests** (engine + JobService). Non-commercial / personal use
(MusicBrainz ToS).

```bash
npm test                              # 101 tests
npm run typecheck                     # type-check the engine + API
npm --prefix web run build            # type-check + build the web app
```

Docs: [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`CLI.md`](docs/CLI.md) ·
[`design/JOBS_AND_ENRICHMENT.md`](docs/design/JOBS_AND_ENRICHMENT.md).

**Possible next:** play history / scrobbling · replaygain / gapless · lyrics · a richer insights
dashboard · photos/videos in the new app.
