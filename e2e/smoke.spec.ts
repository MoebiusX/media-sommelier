import { test, expect } from '@playwright/test';
import { SEED, gotoApp, openTab } from './helpers';

test.describe('harness smoke', () => {
  test('app shell loads with the seeded catalog', async ({ page }) => {
    await gotoApp(page);

    // Sidebar tabs are all present.
    for (const tab of ['Library', 'Playlists', 'Organize', 'Sync', 'Overview'] as const) {
      await expect(page.getByRole('button', { name: tab, exact: true })).toBeVisible();
    }

    // Library is the default landing tab and shows the seeded artists.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Library');
    await expect(page.getByText(SEED.artists.testers.name)).toBeVisible();
    await expect(page.locator('.list-count')).toContainText(String(SEED.counts.artists));
  });

  test('overview reflects seeded totals', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');
    // The "Tracks" stat tile shows the seeded track count.
    const tracksTile = page.locator('.stat', { hasText: 'Tracks' }).first();
    await expect(tracksTile.locator('.stat-value')).toHaveText(String(SEED.counts.tracks));
  });
});
