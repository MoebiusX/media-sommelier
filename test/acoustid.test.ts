import { describe, it, expect } from 'vitest';
import { parseLookupResponse } from '../src/engine/index.js';

/** Network-free tests of the AcoustID response parser. */
describe('AcoustID lookup parsing', () => {
  it('extracts the best recording + release group from an ok response', () => {
    const json = {
      status: 'ok',
      results: [
        { id: 'low', score: 0.4, recordings: [{ id: 'rec-x', title: 'Wrong' }] },
        {
          id: 'acoustid-1',
          score: 0.97,
          recordings: [
            {
              id: 'rec-1',
              title: 'Stairway to Heaven',
              artists: [{ name: 'Led Zeppelin' }],
              releasegroups: [{ id: 'rg-1', title: 'Led Zeppelin IV' }],
            },
          ],
        },
      ],
    };
    const r = parseLookupResponse(json);
    expect(r.ok).toBe(true);
    expect(r.best?.score).toBe(0.97);
    expect(r.best?.recordingTitle).toBe('Stairway to Heaven');
    expect(r.best?.artist).toBe('Led Zeppelin');
    expect(r.best?.releaseGroupTitle).toBe('Led Zeppelin IV');
  });

  it('reports an API error (e.g. wrong key type) cleanly', () => {
    const r = parseLookupResponse({ status: 'error', error: { message: 'invalid API key' } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid API key/);
  });

  it('handles a no-match ok response', () => {
    const r = parseLookupResponse({ status: 'ok', results: [] });
    expect(r.ok).toBe(true);
    expect(r.matchCount).toBe(0);
    expect(r.best).toBeUndefined();
  });
});
