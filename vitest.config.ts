import { defineConfig } from 'vitest/config';

// The unit suite lives entirely under test/**/*.test.ts. Scope Vitest to it explicitly so it does NOT
// try to collect the Playwright E2E specs (e2e/**/*.spec.ts), which use @playwright/test's runner and
// are executed by `npm run test:e2e`, not Vitest.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
