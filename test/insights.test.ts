import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseDirListing, reconstruct, computeInsights } from '../src/engine/index.js';

const records = parseDirListing(readFileSync('test/fixtures/sample/sample-collection.dir.txt', 'utf8'));
const ins = computeInsights(records, reconstruct(records));

describe('collection insights', () => {
  it('reports an all-lossy library', () => {
    expect(ins.collection.losslessRatio).toBe(0);
    expect(ins.collection.formats.mp3).toBe(146);
  });
  it('flags a compilation-heavy collection', () => {
    expect(ins.collection.compilationRatio).toBeGreaterThanOrEqual(0.4);
  });
});

describe('owner profiling — honest gating', () => {
  it('withholds the build-history timeline because of the one-day bulk import', () => {
    expect(ins.owner.buildHistory.reliable).toBe(false);
    expect(ins.owner.buildHistory.reason).toMatch(/bulk copy|one date/i);
  });
  it('declines classic-vs-new without enough known years (needs V1 enrichment)', () => {
    expect(ins.owner.classicVsNew.computable).toBe(false);
  });
  it('describes the collection with neutral, non-judgmental observations', () => {
    const labels = ins.owner.archetypes.map((a) => a.label.toLowerCase()).join(' | ');
    expect(labels).toMatch(/compilation|lossy|lossless|mixed/);
    for (const a of ins.owner.archetypes) expect(a.confidence).toBeGreaterThan(0);
  });

  it('does NOT label the owner a "sampler" from orphan artifacts', () => {
    const labels = ins.owner.archetypes.map((a) => a.label.toLowerCase()).join(' | ');
    expect(labels).not.toMatch(/sampler|completionist|convenience|casual/);
  });
});
