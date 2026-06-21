/**
 * SQLite schema + connection for the new Media Sommelier app layer.
 *
 * Backed by better-sqlite3 (synchronous, ships a prebuilt binary — verified to load on this machine).
 * The DB is a *derived projection* of the engine output: scanLibraryCached() supplies tag-level tracks
 * and reconstruct() supplies folder-based album grouping. Source media is never touched; this file lives
 * under data/ (gitignored).
 *
 * Tables:
 *   artists  — one row per album-artist, with rolled-up track/album counts
 *   albums   — one row per reconstructed AlbumCandidate (folder grouping)
 *   tracks   — one row per audio file (tag-level), linked to its album candidate
 *   meta     — key/value overview stats + the tag-vs-folder grouping simulation (JSON blobs)
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

export const DEFAULT_DB_PATH = 'data/sommelier.db';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS artists (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  trackCount  INTEGER NOT NULL DEFAULT 0,
  albumCount  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS albums (
  id          TEXT    PRIMARY KEY,           -- AlbumCandidate.id
  artistName  TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  year        INTEGER,
  coverPath   TEXT,
  trackCount  INTEGER NOT NULL DEFAULT 0,
  lossless    INTEGER NOT NULL DEFAULT 0,    -- 1 if every track is lossless
  flags       TEXT    NOT NULL DEFAULT '[]', -- json array of CandidateFlag
  confidence  REAL    NOT NULL DEFAULT 0,
  evidence    TEXT    NOT NULL DEFAULT '[]', -- json array of strings
  sourceDir   TEXT,
  sizeBytes   INTEGER NOT NULL DEFAULT 0,
  discCount   INTEGER NOT NULL DEFAULT 1,
  completeness REAL   NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tracks (
  id          INTEGER PRIMARY KEY,
  albumId     TEXT    REFERENCES albums(id),
  artistName  TEXT,
  album       TEXT,
  title       TEXT    NOT NULL,
  trackNo     INTEGER,
  discNo      INTEGER,
  durationMs  INTEGER,
  bitrateKbps INTEGER,
  lossless    INTEGER NOT NULL DEFAULT 0,
  sizeBytes   INTEGER NOT NULL DEFAULT 0,
  path        TEXT    NOT NULL UNIQUE,
  genre       TEXT,
  year        INTEGER
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                        -- json
);

-- Online metadata/cover refreshes; survives clearAll so a re-ingest keeps applied covers/title/year.
CREATE TABLE IF NOT EXISTS album_overrides (
  albumId   TEXT PRIMARY KEY,
  title     TEXT,
  year      INTEGER,
  coverPath TEXT,
  mbid      TEXT,
  fetchedAt INTEGER NOT NULL DEFAULT 0
);

-- Enrichment ledger: caches the MusicBrainz/Cover Art Archive attempt per album so re-runs and
-- resumed sweeps skip the network for everything already tried.
CREATE TABLE IF NOT EXISTS album_enrich (
  albumId     TEXT PRIMARY KEY,
  attemptedAt INTEGER NOT NULL,
  matched     INTEGER NOT NULL,
  mbid        TEXT,
  rgMbid      TEXT,
  matchArtist TEXT,
  matchAlbum  TEXT,
  matchYear   INTEGER,
  score       REAL,
  coverState  TEXT
);

CREATE INDEX IF NOT EXISTS idx_tracks_albumId    ON tracks(albumId);
CREATE INDEX IF NOT EXISTS idx_tracks_artistName ON tracks(artistName);
CREATE INDEX IF NOT EXISTS idx_albums_artistName ON albums(artistName);
CREATE INDEX IF NOT EXISTS idx_albums_title      ON albums(title);
`;

/** Open (creating dirs + schema as needed) the SQLite database. */
export function openDb(path: string = DEFAULT_DB_PATH): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(SCHEMA);
  return db;
}

/** Wipe all derived rows so an ingest is fully idempotent (re-run = same result). */
export function clearAll(db: DB): void {
  db.exec('DELETE FROM tracks; DELETE FROM albums; DELETE FROM artists; DELETE FROM meta;');
}

export function setMeta(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

export function getMeta<T>(db: DB, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}
