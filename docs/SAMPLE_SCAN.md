# Quick scan (directory-listing only)

Source: test/fixtures/sample/sample-collection.dir.txt
Audio files: **146**   |   Audio bytes: **1.3 GB**   |   Album-folders: **12**

## Format / volume
Lossless ratio: **0.0%** (0/146)
Extensions: `mp3`×146, `jpg`×3, `db`×1
Avg track size: **8.9 MB**  → at a typical ~4 min/track that implies roughly ~310 kbps MP3 (header read needed to confirm).

## Naming-scheme entropy (the core mess)
Distinct schemes seen across the set: **5**
-  63×  track - Title
-  31×  Artist - Title (no track #)
-  26×  Artist - (NN)Title
-  21×  track - ARTIST - Title
-   5×  discTrack_artist_title (101-artist-title)

## Album-integrity signals
### Split releases (disc/volume folders that should be ONE release)
- **pink floyd - echoes** → 2 folders, 26 tracks total:
    - `Pink Floyd - Echoes Cd 1` (13 tracks)
    - `Pink Floyd - Echoes Cd 2` (13 tracks)
- **supertramp - very best of** → 2 folders, 29 tracks total:
    - `Supertramp - Very Best of (volume1)` (15 tracks)
    - `Supertramp - Very Best of (volume2)` (14 tracks)

### Orphans (album-folder with a single track — likely a stripped album)
- `Mediterraneo` — only "Marc Antoine - Mediterrneo.mp3"
- `Top 100` — only "The Eagles - Hotel California.mp3"

### Missing track numbers (original sequence lost)
- `Mediterraneo` — 0% of 1 tracks carry a track number
- `Pink Floyd - Echoes Cd 1` — 0% of 13 tracks carry a track number
- `Pink Floyd - Echoes Cd 2` — 0% of 13 tracks carry a track number
- `Supertramp - Very Best of (volume1)` — 0% of 15 tracks carry a track number
- `Supertramp - Very Best of (volume2)` — 0% of 14 tracks carry a track number
- `Top 100` — 0% of 1 tracks carry a track number

## Duplicate candidates (same normalised title in >1 folder — verify by fingerprint)
- **another one bites the dust** ×2: `Greatest Hits I` , `Greatest Hits III`
- **somebody to love** ×2: `Greatest Hits I` , `Greatest Hits III`
- **the show must go on** ×2: `Greatest Hits II` , `Greatest Hits III`

## Build history (file mtimes = copy events, NOT original acquisition)
- 2024-10-30: 145 files
- 2025-03-29: 1 files

## Per-album detail
| Album folder | Tracks | Size | Avg/track | Track #s | Cover | Scheme |
|---|--:|--:|--:|--:|:-:|---|
| MIDNIGHT OIL - The Best Of | 18 | 87 MB | 4.8 MB | 100% | — | track - ARTIST - Title |
| Greatest Hits I | 17 | 134 MB | 7.9 MB | 100% | — | track - Title |
| Greatest Hits II | 17 | 174 MB | 10.2 MB | 100% | — | track - Title |
| Greatest Hits III | 17 | 169 MB | 9.9 MB | 100% | — | track - Title |
| Sting & The Police - The Very Best | 15 | 144 MB | 9.6 MB | 100% | — | track - Title; track - ARTIST - Title |
| Supertramp - Very Best of (volume1) | 15 | 90 MB | 6.0 MB | 0% | ✓ | Artist - Title (no track #) |
| Supertramp - Very Best of (volume2) | 14 | 87 MB | 6.2 MB | 0% | ✓ | Artist - Title (no track #) |
| Pink Floyd - Echoes Cd 1 | 13 | 141 MB | 10.8 MB | 0% | — | Artist - (NN)Title |
| Pink Floyd - Echoes Cd 2 | 13 | 144 MB | 11.1 MB | 0% | — | Artist - (NN)Title |
| CD 2 | 5 | 101 MB | 20.3 MB | 100% | — | discTrack_artist_title (101-artist-title) |
| Mediterraneo | 1 | 7.4 MB | 7.4 MB | 0% | — | Artist - Title (no track #) |
| Top 100 | 1 | 17 MB | 16.7 MB | 0% | ✓ | Artist - Title (no track #) |
