import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReplayGain } from '../src/engine/index.js';

// readReplayGain reads embedded ReplayGain tags via music-metadata. We can't synthesize a tagged audio
// fixture cheaply, so these tests pin the load-bearing CONTRACT: it must degrade gracefully (never throw,
// always return the all-null shape) for missing / non-audio files, which is what keeps playback unchanged
// when a file has no tags.
describe('readReplayGain graceful degrade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'somm-loudness-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const EMPTY = { trackGainDb: null, albumGainDb: null, trackPeak: null, albumPeak: null, source: null };

  it('returns the all-null shape for a missing file (never throws)', async () => {
    const rg = await readReplayGain(join(dir, 'does-not-exist.mp3'));
    expect(rg).toEqual(EMPTY);
  });

  it('returns source:null for a non-audio file', async () => {
    const f = join(dir, 'not-audio.txt');
    writeFileSync(f, 'this is plainly not an audio container');
    const rg = await readReplayGain(f);
    expect(rg).toEqual(EMPTY);
    expect(rg.source).toBeNull();
  });
});
