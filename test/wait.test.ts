import { describe, it, expect } from 'vitest';
import { waitForPath } from '../src/engine/index.js';

describe('waitForPath', () => {
  it('resolves true as soon as the path appears', async () => {
    let checks = 0;
    const ok = await waitForPath('Y:/Music', {
      intervalMs: 1,
      exists: async () => ++checks >= 3, // appears on the 3rd poll
      sleep: async () => {},
    });
    expect(ok).toBe(true);
    expect(checks).toBe(3);
  });

  it('resolves false after the timeout when the path never appears', async () => {
    let waits = 0;
    const ok = await waitForPath('Y:/Music', {
      intervalMs: 10,
      timeoutMs: 30,
      exists: async () => false,
      sleep: async () => {},
      onWait: () => waits++,
    });
    expect(ok).toBe(false);
    expect(waits).toBeGreaterThan(0); // it actually waited and gave up
  });
});
