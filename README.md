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

A single slice of a real drive — `Y:\Car Playlists\Selection` — already shows every failure mode.
Run the diagnostic yourself:

```bash
node tools/scan-dirlisting.mjs test/fixtures/real-world/car-playlists-selection.dir.txt
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

## What it tells you, after a scan

- **About the collection:** dominant styles/genres, total volume, format & lossless breakdown,
  bitrate/quality (incl. fake-FLAC / transcode detection), duplicates, album completeness.
- **About the owner:** acquisition timeline & collecting eras, classic-vs-new %, taste profile,
  completionist-vs-sampler, audiophile signal, "collector archetype" (computed locally — this is
  sensitive inference and stays on-device).

## Repo layout

```
docs/        design docs + generated sample scan
tools/       standalone diagnostics (dir-listing scanner)
test/        fixtures incl. the real-world Car Playlists sample
packages/    (engine core, app, cli — landing with the implementation plan)
```

## Status

Greenfield. The detailed, multi-phase implementation plan
([`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)) is being generated from a multi-agent
design pass and will land next.
