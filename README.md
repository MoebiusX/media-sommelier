# Media Sommelier

A desktop app that **reads your scattered media collection, rebuilds it into usable units (albums,
photo events, video series), and tells you interesting things about both the collection and its owner.**

It does not just list files. It tastes the cellar.

## The problem it solves

Media collections decay. Albums get split across folders, track numbers vanish, the same song shows up
three times under three spellings, and a whole discography gets reduced to one stray hit. Existing tools
either re-tag in place (risky) or organize by filename (garbage in, garbage out).

This is fundamentally an **entity-resolution** problem: take a pile of mistagged/scattered/duplicated
files and reconstruct the real *releases* they belong to — using audio fingerprinting + online databases,
with folder/tag/acoustic heuristics as fallback.

### Real example (this repo's test fixture)

A single slice of a real drive — `X:\Music` — already shows every failure mode.
Run the diagnostic yourself:

```bash
node tools/scan-dirlisting.mjs test/fixtures/sample/sample-collection.dir.txt
```

It finds, from **filenames alone** (146 tracks, 1.3 GB, 0% lossless):

- **5 different naming schemes** in one folder tree (`101-led_zeppelin-rock_and_roll`,
  `01 - MIDNIGHT  OIL - Title`, `Pink Floyd - (05)Echoes`, `Artist - Title` with no track number, …).
- **Split releases** — *Pink Floyd – Echoes* exists as two sibling top-level folders (`Echoes Cd 1`,
  `Echoes Cd 2`) instead of one 2-disc release; same for *Supertramp – The Very Best Of*.
- **Orphans** — *Marc Antoine – Mediterráneo* and *The Eagles* reduced to a single track each.
- **Lost sequence** — 71 tracks carry no track number at all (original order is gone).
- **Duplicate candidates across discs** (Queen Platinum Collection) that must be confirmed by
  fingerprint, not string match — note `Under Presure` vs `Under Pressure`, `Bohemian Rapsody`,
  `I Want To Be Free` (likely *…Break Free*): typos that poison tag-only matching.
- **Build history** — almost every file is stamped `2024-10-30` (a bulk copy event), proving file
  mtimes record *when you copied*, not *when you acquired* — so the "classic vs new" owner axis must
  come from release year, not the filesystem.

The generated report lives in [`docs/SAMPLE_SCAN.md`](docs/SAMPLE_SCAN.md).

## Locked design decisions

| Decision | Choice |
|---|---|
| Form factor | Desktop app (Tauri / Electron), modern TypeScript |
| File safety | **Organize into a new tree (copy)** — source files are never mutated |
| Enrichment | Hybrid — audio fingerprint (AcoustID/Chromaprint) + MusicBrainz/Discogs/Cover Art Archive, with offline fallback |
| Scale | Hundreds of thousands to 1M+ items |
| Media types | Music (priority #1), images, video |

## The local web UI

`npm run ui` serves a single-page app at <http://localhost:4178> — a dark, keyboard-friendly desktop-style
shell over the engine. Type `sample` for the bundled filename-only demo, or **Browse** to point at a real
folder (the sample has no actual media, so the Library, Photos, Videos and player tabs ask for a real folder
and say so). A compact media-type summary (music / photos / videos counts) appears top-right once scanned.

- **Library** — every track as a sortable, filterable grid (artist/title/album/genre/time/bitrate/size),
  backed by an on-disk **tag cache** (keyed by path+size+mtime) so re-scans are near-instant. Click any row
  to play it in the built-in **mini player**: play/pause, prev/next, seek, volume, shuffle, repeat
  (off/all/one), an "Up Next" queue, persisted volume/shuffle/repeat, and full keyboard control
  (Space, ←/→, ↑/↓).
- **Albums** — the reconstruction view: scattered files rebuilt into release candidates with confidence,
  a "why grouped" evidence trace, multi-disc merges, orphans, and duplicate candidates.
- **Photos** — EXIF-driven gallery grouped by day, with camera/GPS stats and a full-screen **lightbox**
  (clamped arrow-key navigation, map links for geotagged shots). Capped grid with a "showing first N" hint.
- **Videos** — a poster grid (frames extracted on demand to `data/posters/`, never touching the source)
  with resolution/codec/duration badges and an in-app player overlay (HTTP Range streaming, so it seeks;
  shows a clear message when a codec can't play in the browser instead of a black frame).
- **Insights** — collection metrics (lossless %, formats, top artists) and on-device owner profiling.
- **Organize** — pick a naming scheme + destination, preview the dry-run plan, then copy into a clean tree
  (originals never touched, optional MusicBrainz enrichment and tag-writing onto the copies).

All file-serving endpoints (`audio` / `video` / `poster` / `cover` / `image`) are **confined to scanned
roots** — a request for any path outside the folders you actually scanned is rejected (403), so a stray web
page can't use the local server to read arbitrary files off your disk.

## What it tells you, after a scan

- **About the collection:** dominant styles/genres, total volume, format & lossless breakdown,
  bitrate/quality (incl. fake-FLAC / transcode detection), duplicates, album completeness.
- **About the owner:** acquisition timeline & collecting eras, classic-vs-new %, taste profile,
  completionist-vs-sampler, audiophile signal, "collector archetype" (computed locally — this is
  sensitive inference and stays on-device).

## Repo layout

```
src/engine/  pure-TS engine: inventory · reconstruct · enrich · organize · insights
src/cli/     command-line interface
src/server/  local web UI (server + single-page app)
docs/        architecture, plan, CLI reference + generated sample scan
tools/       standalone diagnostics (dir-listing scanner)
test/        vitest suites + the bundled sample collection fixture
```

## Status — engine working end-to-end (V0 + V1 enrichment)

The engine is built, tested (**89 tests**), and proven on real audio — it has organized a real album
end-to-end (reconstruct → enrich → copy → tag) with originals untouched. Docs:
[`ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`CLI.md`](docs/CLI.md) ·
[`IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

```bash
npm install
npm test                                                   # 89 tests
LISTING=test/fixtures/sample/sample-collection.dir.txt

# offline, no setup — runs on the bundled real-data sample:
npx tsx src/cli/index.ts reconstruct $LISTING --from-listing             # rebuild albums
npx tsx src/cli/index.ts insights    $LISTING --from-listing             # collection + owner profile
npx tsx src/cli/index.ts enrich      $LISTING --limit 8                  # MusicBrainz corrections (network)
npx tsx src/cli/index.ts plan        $LISTING --from-listing --enrich --dest D:/Organized

# on a real mounted library: omit --from-listing and point at a folder
npx tsx src/cli/index.ts organize "X:/Music" --dest "D:/Organized" --execute --enrich --write-tags
```

`--from-listing` parses a Windows `dir /s` dump (how we test on real data without the drive mounted);
omit it to scan a real folder via the filesystem walker. See [`docs/CLI.md`](docs/CLI.md) for all flags
and the `.env` setup (AcoustID application key, `fpcalc`).

**What works today:** scan (fs walk or listing) → reconstruct albums (multi-disc merge, completeness,
orphans, duplicates) → **enrich** against MusicBrainz with an **AcoustID fingerprint fallback**
(corrects titles/artists/years, adds MBIDs + per-track titles) → **organize** into a clean
`Artist/YYYY Album/Disc N/NN - Title` tree, copy hash-verified and tags written **onto the copies only**
(source is never mutated) → collection + owner insights. Non-commercial/personal use.

**Deferred:** Electron desktop shell; persistent SQLite catalog; corpus-calibrated match thresholds.
