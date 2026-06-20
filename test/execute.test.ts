import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { walkToArray, reconstruct, planOrganize, executePlan } from '../src/engine/index.js';

/**
 * Full real-filesystem integration: synthesize a scattered album on disk, walk it, reconstruct,
 * plan, and EXECUTE the copy — asserting copies are verified by hash and the SOURCE is never mutated.
 * This exercises the fs walker + copy executor (not just the dir-listing import path).
 */
let root: string;

async function writeTrack(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

describe('fs walk → reconstruct → organize → execute (synthetic, source read-only)', () => {
  it('copies a reconstructed album into a clean tree and verifies every copy by hash', async () => {
    root = await mkdtemp(join(tmpdir(), 'sommelier-'));
    const src = join(root, 'src');
    const dest = join(root, 'dest');

    // a split 2-disc release as sibling folders + an in-folder-numbered album
    await writeTrack(join(src, 'Pink Floyd - Echoes Cd 1', 'Pink Floyd - (01)Astronomy Domine.mp3'), 'a1');
    await writeTrack(join(src, 'Pink Floyd - Echoes Cd 1', 'Pink Floyd - (02)See Emily Play.mp3'), 'a2');
    await writeTrack(join(src, 'Pink Floyd - Echoes Cd 2', 'Pink Floyd - (01)Time.mp3'), 'b1');
    await writeTrack(join(src, 'The Police - Greatest', '01 - Roxanne.mp3'), 'c1');
    await writeTrack(join(src, 'The Police - Greatest', '02 - Message In A Bottle.mp3'), 'c2');

    const records = await walkToArray(src, { include: ['music'] });
    expect(records.length).toBe(5);

    const report = reconstruct(records);
    // the two Echoes folders merge into one 2-disc release
    const pf = report.candidates.find((c) => c.albumArtist.toLowerCase().includes('pink floyd'))!;
    expect(pf.discs.length).toBe(2);
    expect(pf.totalTracks).toBe(3);

    const plan = planOrganize(report.candidates, { destRoot: dest });
    const result = await executePlan(plan);

    expect(result.copied).toBe(5);
    expect(result.failed).toBe(0);
    for (const r of result.results) expect(r.sourceHash).toBe(r.copyHash); // verified

    // destination files exist with correct content
    const echoesDisc1 = join(dest, 'Pink Floyd', 'Echoes', 'Disc 1', '01 - Astronomy Domine.mp3');
    expect(await readFile(echoesDisc1, 'utf8')).toBe('a1');

    // SOURCE is untouched — original files still present and unchanged
    expect(await readFile(join(src, 'Pink Floyd - Echoes Cd 1', 'Pink Floyd - (01)Astronomy Domine.mp3'), 'utf8')).toBe('a1');
    const srcStat = await stat(join(src, 'The Police - Greatest', '01 - Roxanne.mp3'));
    expect(srcStat.isFile()).toBe(true);
  });

  it('is idempotent: re-running skips identical destinations', async () => {
    const src = join(root, 'src');
    const dest = join(root, 'dest');
    const records = await walkToArray(src, { include: ['music'] });
    const report = reconstruct(records);
    const plan = planOrganize(report.candidates, { destRoot: dest });
    const second = await executePlan(plan);
    expect(second.copied).toBe(0);
    expect(second.skipped).toBe(5);
  });
});

afterAll(async () => {
  // best-effort cleanup; ignore failures
  try {
    const { rm } = await import('node:fs/promises');
    if (root) await rm(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
