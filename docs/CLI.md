# CLI reference

Run via `npx tsx src/cli/index.ts <command> …` (or `npm run cli -- <command> …`). After `npm run build`,
the `sommelier` bin is available too.

Two input modes for every catalog command:
- a **real folder** — scanned with the filesystem walker (default).
- a **`dir /s` dump** with `--from-listing` — lets you run on a collection without mounting the drive
  (this is how the test fixture works).

## Commands

### `reconstruct <path>`
Rebuild album candidates and print them (artist — album, confidence, flags, "why grouped" evidence).
```
npx tsx src/cli/index.ts reconstruct "Y:/Music" 
npx tsx src/cli/index.ts reconstruct sample.dir.txt --from-listing --html report.html
```
Flags: `--from-listing`, `--json`, `--html <file>` (write a self-contained HTML report),
`--scan-limit <n>` (cap files walked, for huge trees).

### `insights <path>`
Collection metrics (format/lossless, compilation density, completeness, decades, top artists) + owner
profiling (archetypes with confidence, and *honestly gated* build-history / classic-vs-new).
```
npx tsx src/cli/index.ts insights "Y:/Music" --from-listing
```
Flags: `--from-listing`, `--json`.

### `enrich <path>`
Match the top releases to MusicBrainz (corrects title/artist/year, adds MBIDs); AcoustID fingerprint
fallback for the misses when files are readable + a key is set.
```
npx tsx src/cli/index.ts enrich "Y:/Music" --limit 8
```
Flags: `--from-listing`, `--limit <n>` (releases to enrich, default 6), `--offline` (cache only),
`--json`.

### `plan <path>`
Dry-run the organize mapping — show where files *would* go. With `--enrich`, destination paths use
canonical MusicBrainz names/years.
```
npx tsx src/cli/index.ts plan "Y:/Music" --dest "D:/Organized" --enrich
```
Flags: `--from-listing`, `--dest <out>`, `--enrich`, `--min-confidence <n>`, `--json`.

### `organize <path>`
The real thing: copy files into a clean tree. **Dry-run unless `--execute`. Originals are never
modified.** With `--enrich`, matched albums get canonical `Artist/YYYY Album/Disc N/NN - Title` folders;
with `--write-tags`, corrected tags are stamped onto the copies.
```
# preview
npx tsx src/cli/index.ts organize "Y:/Music" --dest "D:/Organized" --enrich
# do it
npx tsx src/cli/index.ts organize "Y:/Music" --dest "D:/Organized" --execute --enrich --write-tags
```
Flags: `--from-listing`, `--dest <out>` (must be **outside** the source tree), `--execute`,
`--write-tags`, `--enrich`, `--min-confidence <n>`.

### `fingerprint <audio-file>`
Compute a Chromaprint fingerprint for one file; if an AcoustID application key is set, look it up.
```
npx tsx src/cli/index.ts fingerprint "Y:/Music/song.mp3"
```

## Configuration (`.env`, gitignored)

```
ACOUSTID_API_KEY=...     # APPLICATION key (the `client` param) — required for AcoustID LOOKUPS.
                         #   Register at https://acoustid.org/new-application (NOT the account key).
ACOUSTID_USER_KEY=...    # account/submission key — only for submitting fingerprints (future).
# FPCALC_PATH=...        # override the fpcalc binary path (else vendor/fpcalc/ or PATH)
```

`fpcalc` (Chromaprint) is fetched into `vendor/` (gitignored) — see `tools/fetch-fpcalc.mjs`.

## Notes
- MusicBrainz/AcoustID calls are rate-limited and cached on disk under `data/` (gitignored); re-runs
  reuse the cache, so a second `--enrich` run skips straight to copying.
- `organize --execute` is idempotent: an existing destination file is skipped.
