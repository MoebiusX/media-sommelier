import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLrc, readLyrics } from '../src/engine/index.js';

describe('parseLrc', () => {
  it('parses [mm:ss.xx] timestamps into seconds, sorted', () => {
    const lines = parseLrc(['[00:12.50]Second', '[00:05.00]First'].join('\n'));
    expect(lines).toEqual([
      { time: 5, text: 'First' },
      { time: 12.5, text: 'Second' },
    ]);
  });

  it('handles millisecond fractions and bare [mm:ss]', () => {
    const lines = parseLrc(['[01:02.345]a', '[00:09]b'].join('\n'));
    expect(lines[0]).toEqual({ time: 9, text: 'b' });
    expect(lines[1]).toEqual({ time: 62.345, text: 'a' });
  });

  it('expands repeated timestamps on one line into separate entries', () => {
    const lines = parseLrc('[00:10.00][00:40.00]chorus');
    expect(lines).toEqual([
      { time: 10, text: 'chorus' },
      { time: 40, text: 'chorus' },
    ]);
  });

  it('drops ID tags and untimed lines', () => {
    const lines = parseLrc(['[ar:Some Artist]', '[length:03:00]', 'no timestamp', '[00:01.00]real'].join('\n'));
    expect(lines).toEqual([{ time: 1, text: 'real' }]);
  });
});

describe('readLyrics sidecar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'somm-lyrics-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a synced .lrc sidecar matched on the file stem', async () => {
    writeFileSync(join(dir, 'song.flac'), 'not real audio');
    writeFileSync(join(dir, 'song.lrc'), '[00:00.00]hello\n[00:03.00]world\n');
    const r = await readLyrics(join(dir, 'song.flac'));
    expect(r.source).toBe('sidecar');
    expect(r.synced).toEqual([
      { time: 0, text: 'hello' },
      { time: 3, text: 'world' },
    ]);
    expect(r.plain).toBe('hello\nworld');
  });

  it('falls back to a plain .txt sidecar when no .lrc is present', async () => {
    writeFileSync(join(dir, 'spoken.mp3'), 'not real audio');
    writeFileSync(join(dir, 'spoken.txt'), 'just plain words');
    const r = await readLyrics(join(dir, 'spoken.mp3'));
    expect(r.source).toBe('sidecar');
    expect(r.synced).toBeNull();
    expect(r.plain).toBe('just plain words');
  });

  it('returns empty when nothing is available (unreadable audio, no sidecar)', async () => {
    writeFileSync(join(dir, 'bare.mp3'), 'not real audio');
    const r = await readLyrics(join(dir, 'bare.mp3'));
    expect(r).toEqual({ synced: null, plain: null, source: null });
  });
});
