import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/server2/db.js';
import { listArtists } from '../src/server2/index.js';

/** Seed a couple of artists + their tracks into an in-memory catalog. */
function seed(db: Database.Database): void {
  const insA = db.prepare('INSERT INTO artists(name,trackCount,albumCount) VALUES(?,?,?)');
  insA.run('The Testers', 5, 2);
  insA.run('Blue Quartet', 1, 1);

  const insT = db.prepare(
    `INSERT INTO tracks(albumId,artistName,album,title,trackNo,discNo,durationMs,bitrateKbps,lossless,sizeBytes,path,genre,year)
     VALUES(NULL,@artistName,NULL,@title,NULL,NULL,NULL,NULL,@lossless,@sizeBytes,@path,@genre,@year)`,
  );
  const t = (o: { artistName: string; lossless: 0 | 1; sizeBytes: number; path: string; genre: string; year: number }) =>
    insT.run({ title: 'x', ...o });

  // The Testers: 3 Rock (one lossless FLAC) + 2 Blues MP3 → topGenre Rock, formats [flac, mp3], years 2001–2003.
  t({ artistName: 'The Testers', lossless: 1, sizeBytes: 35_000_000, path: '/lib/tt/01.flac', genre: 'Rock', year: 2001 });
  t({ artistName: 'The Testers', lossless: 0, sizeBytes: 8_000_000, path: '/lib/tt/02.mp3', genre: 'Rock', year: 2001 });
  t({ artistName: 'The Testers', lossless: 0, sizeBytes: 6_000_000, path: '/lib/tt/03.mp3', genre: 'Rock', year: 2003 });
  t({ artistName: 'The Testers', lossless: 0, sizeBytes: 7_000_000, path: '/lib/tt/04.mp3', genre: 'Blues', year: 2003 });
  t({ artistName: 'The Testers', lossless: 0, sizeBytes: 9_000_000, path: '/lib/tt/05.mp3', genre: 'Blues', year: 2003 });
  // Blue Quartet: one lossless Jazz track.
  t({ artistName: 'Blue Quartet', lossless: 1, sizeBytes: 40_000_000, path: '/lib/bq/01.flac', genre: 'Jazz', year: 1999 });
}

describe('listArtists — enriched /api/artists rollups', () => {
  it('rolls up topGenre, genres, formats, anyLossless, size and the active-year span', () => {
    const db = openDb(':memory:');
    seed(db);
    const rows = listArtists(db);

    const tt = rows.find((r) => r.name === 'The Testers');
    expect(tt).toBeDefined();
    expect(tt!.topGenre).toBe('Rock'); // 3 Rock beats 2 Blues
    expect([...tt!.genres].sort()).toEqual(['Blues', 'Rock']);
    expect(tt!.formats).toEqual(['flac', 'mp3']);
    expect(tt!.anyLossless).toBe(true);
    expect(tt!.sizeBytes).toBe(35_000_000 + 8_000_000 + 6_000_000 + 7_000_000 + 9_000_000);
    expect(tt!.minYear).toBe(2001);
    expect(tt!.maxYear).toBe(2003);

    const bq = rows.find((r) => r.name === 'Blue Quartet');
    expect(bq!.topGenre).toBe('Jazz');
    expect(bq!.anyLossless).toBe(true);
    db.close();
  });

  it('orders busiest-first and degrades gracefully for a track-less artist', () => {
    const db = openDb(':memory:');
    seed(db);
    db.prepare('INSERT INTO artists(name,trackCount,albumCount) VALUES(?,?,?)').run('Ghost', 0, 0);
    const rows = listArtists(db);

    expect(rows[0]?.name).toBe('The Testers'); // 5 tracks → first
    const ghost = rows.find((r) => r.name === 'Ghost');
    expect(ghost!.topGenre).toBeNull();
    expect(ghost!.genres).toEqual([]);
    expect(ghost!.formats).toEqual([]);
    expect(ghost!.anyLossless).toBe(false);
    expect(ghost!.sizeBytes).toBe(0);
    db.close();
  });
});
