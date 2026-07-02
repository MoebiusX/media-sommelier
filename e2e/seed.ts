/**
 * E2E seed — builds a small, deterministic library + SQLite catalog for the Playwright suite.
 *
 * It is a mirror of what src/server2/ingest.ts would produce for a tiny hand-authored collection, but
 * with NO scanning/tag-reading: we write the rows directly. Everything lives under e2e/.tmp/ (gitignored)
 * and is fully rebuilt on every run, so tests are reproducible and the user's real data/sommelier.db is
 * never touched.
 *
 * What it creates:
 *   - e2e/.tmp/library/**            small real silent WAV files (browser-decodable → playback works)
 *   - e2e/.tmp/covers/al-debut.jpg   a 1x1 image so exactly one album has a real cover (others fall back)
 *   - <SOMMELIER_DB>                  the SQLite catalog (artists/albums/tracks/meta/album_overrides)
 *
 * The server (src/server2/index.ts) is pointed at the same DB + a matching PORT via env; its own openDb()
 * adds the remaining tables (profiles/playlists/jobs) at startup with CREATE TABLE IF NOT EXISTS.
 *
 * Run:  SOMMELIER_DB=<abs> tsx e2e/seed.ts    (Playwright's webServer does this before starting the API)
 */
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openDb } from '../src/server2/db.js';

const ROOT = resolve(process.cwd());
const TMP = join(ROOT, 'e2e', '.tmp');
const LIB = join(TMP, 'library'); // meta.overview.root — every track path lives under here
const COVERS = join(TMP, 'covers');
const DB_PATH = resolve(process.env.SOMMELIER_DB ?? join(TMP, 'sommelier-e2e.db'));

/* ----------------------------------- fixtures ----------------------------------- */

/** A minimal valid 16-bit PCM mono WAV of `seconds` of silence — small, and Chromium decodes it.
 *  15s (not ~2s) so a clip never reaches its end mid-test (which would auto-advance/pause the player). */
function makeWav(seconds = 15, sampleRate = 8000): Buffer {
  const numSamples = Math.floor(seconds * sampleRate);
  const dataSize = numSamples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // audio format = PCM
  buf.writeUInt16LE(1, 22); // channels = mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  // sample data left as zeros (silence)
  return buf;
}

/** 1×1 transparent PNG (bytes served with an image/* type; <img> renders it → tests the real-cover path). */
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/* ----------------------------------- catalog ------------------------------------ */

interface TrackSpec {
  title: string;
  no: number | null;
  disc?: number;
  durationMs: number;
  bitrate: number | null;
  lossless: 0 | 1;
  sizeBytes: number;
  /** path relative to LIB; if absent, `${dir}/${no|title}.wav` under the album dir is used */
  rel?: string;
  file?: string;
}
interface AlbumSpec {
  id: string;
  artist: string;
  title: string;
  year: number;
  genre: string;
  lossless: 0 | 1;
  discCount: number;
  flags: string[];
  confidence: number;
  completeness: number;
  dir?: string; // album folder relative to LIB (single-folder albums)
  cover?: boolean; // seed a real cover via album_overrides
  tracks: TrackSpec[];
}

const MB = 1_000_000;

const ALBUMS: AlbumSpec[] = [
  {
    id: 'al-debut',
    artist: 'The Testers',
    title: 'Debut',
    year: 2001,
    genre: 'Rock',
    lossless: 0,
    discCount: 1,
    flags: [],
    confidence: 0.72,
    completeness: 1,
    dir: 'The Testers/Debut',
    cover: true,
    tracks: [
      { title: 'Wanderer', no: 1, durationMs: 200_000, bitrate: null, lossless: 1, sizeBytes: 35 * MB, file: '01 Wanderer.wav' },
      { title: 'Signal Fire', no: 2, durationMs: 240_000, bitrate: 256, lossless: 0, sizeBytes: 8 * MB, file: '02 Signal Fire.wav' },
      { title: 'Cover Song', no: 3, durationMs: 180_000, bitrate: 256, lossless: 0, sizeBytes: 6 * MB, file: '03 Cover Song.wav' },
    ],
  },
  {
    id: 'al-live',
    artist: 'The Testers',
    title: 'Live Sessions',
    year: 2003,
    genre: 'Rock',
    lossless: 0,
    discCount: 1,
    flags: ['needs-review', 'no-track-numbers'],
    confidence: 0.4,
    completeness: 0.5,
    dir: 'The Testers/Live Sessions',
    tracks: [
      // Same title+artist+~duration as al-debut "Wanderer" → a duplicate group; this lossy copy is NOT the keeper.
      { title: 'Wanderer', no: null, durationMs: 201_000, bitrate: 192, lossless: 0, sizeBytes: 9 * MB, file: 'Wanderer (Live).wav' },
      { title: 'Encore', no: null, durationMs: 220_000, bitrate: 192, lossless: 0, sizeBytes: 7 * MB, file: 'Encore.wav' },
    ],
  },
  {
    id: 'al-signals',
    artist: 'Ada Lovelace',
    title: 'Signals',
    year: 2018,
    genre: 'Electronic',
    lossless: 0,
    discCount: 2,
    flags: ['multi-folder-merge'],
    confidence: 0.68,
    completeness: 1,
    // Two disc folders under one album tag → an "integrated" album for the metadata reconstruction sim.
    tracks: [
      { title: 'Intro', no: 1, disc: 1, durationMs: 120_000, bitrate: 256, lossless: 0, sizeBytes: 5 * MB, rel: 'Ada Lovelace/Signals/Disc 1/01 Intro.wav' },
      { title: 'Pulse', no: 2, disc: 1, durationMs: 260_000, bitrate: 256, lossless: 0, sizeBytes: 9 * MB, rel: 'Ada Lovelace/Signals/Disc 1/02 Pulse.wav' },
      { title: 'Echoes', no: 1, disc: 2, durationMs: 300_000, bitrate: 256, lossless: 0, sizeBytes: 10 * MB, rel: 'Ada Lovelace/Signals/Disc 2/01 Echoes.wav' },
      { title: 'Outro', no: 2, disc: 2, durationMs: 90_000, bitrate: 256, lossless: 0, sizeBytes: 4 * MB, rel: 'Ada Lovelace/Signals/Disc 2/02 Outro.wav' },
    ],
  },
  {
    id: 'al-midnight',
    artist: 'Blue Quartet',
    title: 'Midnight',
    year: 1999,
    genre: 'Jazz',
    lossless: 1, // every track lossless → FLAC badge
    discCount: 1,
    flags: [],
    confidence: 0.75,
    completeness: 1,
    dir: 'Blue Quartet/Midnight',
    tracks: [
      { title: 'Blue in Green', no: 1, durationMs: 320_000, bitrate: null, lossless: 1, sizeBytes: 40 * MB, file: '01 Blue in Green.wav' },
      { title: 'Night Train', no: 2, durationMs: 280_000, bitrate: null, lossless: 1, sizeBytes: 34 * MB, file: '02 Night Train.wav' },
      { title: 'After Hours', no: 3, durationMs: 410_000, bitrate: null, lossless: 1, sizeBytes: 52 * MB, file: '03 After Hours.wav' },
    ],
  },
  {
    id: 'al-roadtrip',
    artist: 'Various Artists',
    title: 'Road Trip Mix',
    year: 2010,
    genre: 'Pop',
    lossless: 0,
    discCount: 1,
    flags: ['possible-compilation'],
    confidence: 0.5,
    completeness: 1,
    dir: 'Various Artists/Road Trip Mix',
    tracks: [
      { title: 'Sunset Drive', no: 1, durationMs: 210_000, bitrate: 256, lossless: 0, sizeBytes: 8 * MB, file: '01 Sunset Drive.wav' },
      { title: 'Neon Nights', no: 2, durationMs: 230_000, bitrate: 256, lossless: 0, sizeBytes: 8 * MB, file: '02 Neon Nights.wav' },
      { title: 'Open Road', no: 3, durationMs: 250_000, bitrate: 256, lossless: 0, sizeBytes: 9 * MB, file: '03 Open Road.wav' },
    ],
  },
  {
    id: 'al-drift',
    artist: 'Echo Chamber',
    title: 'Drift',
    year: 2020,
    genre: 'Ambient',
    lossless: 0,
    discCount: 1,
    flags: ['orphan'],
    confidence: 0.3,
    completeness: 1,
    dir: 'Echo Chamber/Drift',
    tracks: [{ title: 'Drift', no: 1, durationMs: 600_000, bitrate: 256, lossless: 0, sizeBytes: 22 * MB, file: '01 Drift.wav' }],
  },
];

/** Resolve a track's path relative to LIB. */
function relOf(al: AlbumSpec, t: TrackSpec): string {
  if (t.rel) return t.rel;
  return `${al.dir}/${t.file}`;
}

/* ----------------------------------- build -------------------------------------- */

function main(): void {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(LIB, { recursive: true });
  mkdirSync(COVERS, { recursive: true });

  const wav = makeWav();

  const db = openDb(DB_PATH);
  db.exec('DELETE FROM tracks; DELETE FROM albums; DELETE FROM artists; DELETE FROM meta; DELETE FROM album_overrides;');

  const insAlbum = db.prepare(
    `INSERT INTO albums(id,artistName,title,year,coverPath,trackCount,lossless,flags,confidence,evidence,sourceDir,sizeBytes,discCount,completeness)
     VALUES(@id,@artistName,@title,@year,@coverPath,@trackCount,@lossless,@flags,@confidence,@evidence,@sourceDir,@sizeBytes,@discCount,@completeness)`,
  );
  const insTrack = db.prepare(
    `INSERT INTO tracks(albumId,artistName,album,title,trackNo,discNo,durationMs,bitrateKbps,lossless,sizeBytes,path,genre,year)
     VALUES(@albumId,@artistName,@album,@title,@trackNo,@discNo,@durationMs,@bitrateKbps,@lossless,@sizeBytes,@path,@genre,@year)`,
  );
  const insArtist = db.prepare('INSERT INTO artists(name,trackCount,albumCount) VALUES(?,?,?)');

  // per-artist rollups
  const artistTracks = new Map<string, number>();
  const artistAlbums = new Map<string, number>();
  const genreCount = new Map<string, number>();
  const yearCount = new Map<number, number>();
  let totalBytes = 0;
  let losslessTracks = 0;
  let totalTracks = 0;
  let totalDurationMs = 0;

  const tx = db.transaction(() => {
    for (const al of ALBUMS) {
      const sizeBytes = al.tracks.reduce((n, t) => n + t.sizeBytes, 0);
      const firstRel = relOf(al, al.tracks[0]!);
      const sourceDir = dirname(join(LIB, firstRel));
      insAlbum.run({
        id: al.id,
        artistName: al.artist,
        title: al.title,
        year: al.year,
        coverPath: null,
        trackCount: al.tracks.length,
        lossless: al.lossless,
        flags: JSON.stringify(al.flags),
        confidence: al.confidence,
        evidence: JSON.stringify([
          `${al.tracks.length} tracks share the folder “${al.dir ?? al.title}”`,
          'consistent album tag across tracks',
        ]),
        sourceDir,
        sizeBytes,
        discCount: al.discCount,
        completeness: al.completeness,
      });
      artistAlbums.set(al.artist, (artistAlbums.get(al.artist) ?? 0) + 1);

      for (const t of al.tracks) {
        const rel = relOf(al, t);
        const abs = join(LIB, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, wav);
        insTrack.run({
          albumId: al.id,
          artistName: al.artist,
          album: al.title,
          title: t.title,
          trackNo: t.no,
          discNo: t.disc ?? 1,
          durationMs: t.durationMs,
          bitrateKbps: t.bitrate,
          lossless: t.lossless,
          sizeBytes: t.sizeBytes,
          path: abs,
          genre: al.genre,
          year: al.year,
        });
        artistTracks.set(al.artist, (artistTracks.get(al.artist) ?? 0) + 1);
        genreCount.set(al.genre, (genreCount.get(al.genre) ?? 0) + 1);
        yearCount.set(al.year, (yearCount.get(al.year) ?? 0) + 1);
        totalBytes += t.sizeBytes;
        losslessTracks += t.lossless;
        totalTracks += 1;
        totalDurationMs += t.durationMs;
      }

      if (al.cover) {
        const coverPath = join(COVERS, `${al.id}.jpg`);
        writeFileSync(coverPath, ONE_PX_PNG);
        db.prepare(
          `INSERT INTO album_overrides(albumId,title,year,coverPath,mbid,fetchedAt) VALUES(?,?,?,?,?,?)`,
        ).run(al.id, null, null, coverPath, null, 0);
      }
    }

    // artists table (one row per album-artist, with rolled-up counts)
    for (const [name, tracks] of artistTracks) {
      insArtist.run(name, tracks, artistAlbums.get(name) ?? 0);
    }
  });
  tx();

  // ---- overview + grouping meta (the projection the Overview page reads) ----
  const topArtists = [...artistTracks.entries()]
    .map(([name, tracks]) => ({ name, tracks }))
    .sort((a, b) => b.tracks - a.tracks || a.name.localeCompare(b.name));
  const topGenres = [...genreCount.entries()]
    .map(([name, tracks]) => ({ name, tracks }))
    .sort((a, b) => b.tracks - a.tracks || a.name.localeCompare(b.name));
  const topYears = [...yearCount.entries()]
    .map(([year, tracks]) => ({ year, tracks }))
    .sort((a, b) => b.tracks - a.tracks || b.year - a.year);
  const formats = { wav: totalTracks };

  const human = (n: number): string => {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
  };

  const setMeta = (key: string, value: unknown) =>
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
      key,
      JSON.stringify(value),
    );

  setMeta('overview', {
    root: LIB,
    tracks: totalTracks,
    albums: ALBUMS.length,
    artists: artistTracks.size,
    genres: topGenres.length,
    totalBytes,
    totalHuman: human(totalBytes),
    totalDurationMs,
    losslessRatio: totalTracks ? losslessTracks / totalTracks : 0,
    formats,
    topArtists: topArtists.slice(0, 8),
    topGenres: topGenres.slice(0, 8),
    topYears: topYears.slice(0, 8),
    multiDisc: 1,
    needsReview: 1,
    compilations: 1,
    ingestedAt: '2026-07-01T00:00:00.000Z',
  });

  // A tag-vs-folder grouping simulation where folder reconstruction wins (rescues an orphan).
  setMeta('grouping', {
    folder: { groups: ALBUMS.length, orphanCandidates: 1, orphanTracks: 1 },
    tag: { groups: ALBUMS.length, orphanTracks: 3, untaggedTracks: 0, singletonGroups: 3 },
    verdict: 'Folder reconstruction leaves fewer orphan tracks than naive tag grouping.',
  });

  db.close();

  // eslint-disable-next-line no-console
  console.log(
    `[e2e seed] ${totalTracks} tracks / ${ALBUMS.length} albums / ${artistTracks.size} artists → ${DB_PATH}\n` +
      `[e2e seed] library root: ${LIB}`,
  );
}

main();
