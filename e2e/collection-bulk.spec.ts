import { test, expect } from '@playwright/test';
import { SEED, gotoApp, openTab, deleteAllPlaylists } from './helpers';

/**
 * Multi-select + bulk actions on the Albums grid: select albums via their checkboxes, then add the whole
 * selection to a (new) playlist. Reuses the real /api/playlist* endpoints; MUTATING, so we clean up.
 */
async function openAlbums(page: import('@playwright/test').Page) {
  await openTab(page, 'Library');
  await page.locator('.lib-tabs button', { hasText: 'Albums' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Albums');
}

test.describe('collection bulk actions', () => {
  test.beforeEach(async ({ page }) => {
    await deleteAllPlaylists(page);
  });
  test.afterEach(async ({ page }) => {
    await deleteAllPlaylists(page);
  });

  test('selecting albums shows the bulk bar and clears it', async ({ page }) => {
    await gotoApp(page);
    await openAlbums(page);

    // No bulk bar until something is selected.
    await expect(page.locator('.bulk-bar')).toHaveCount(0);

    await page.locator('.album-card', { hasText: SEED.albums.debut.title }).locator('.csel-grid').check();
    await expect(page.locator('.bulk-bar')).toBeVisible();
    await expect(page.locator('.bulk-count')).toHaveText('1 selected');
    await expect(page.locator('.list-count')).toContainText('· 1 selected');

    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(page.locator('.bulk-bar')).toHaveCount(0);
  });

  test('adds the whole selection to a new playlist', async ({ page }) => {
    await gotoApp(page);
    await openAlbums(page);

    // Select two albums (Debut = 3 tracks, Midnight = 3 tracks → 6 total).
    await page.locator('.album-card', { hasText: SEED.albums.debut.title }).locator('.csel-grid').check();
    await page.locator('.album-card', { hasText: SEED.albums.midnight.title }).locator('.csel-grid').check();
    await expect(page.locator('.bulk-count')).toHaveText('2 selected');

    // "Add to playlist ▾" → "+ New…" → name it via the prompt.
    page.once('dialog', (d) => d.accept('Bulk Set'));
    await page.locator('.bulk-bar').getByRole('button', { name: /Add to playlist/ }).click();
    await page.locator('.bulk-bar .atp-menu .atp-item.new').click();

    // The bulk bar confirms and the selection clears.
    await expect(page.locator('.bulk-bar')).toHaveCount(0);

    // Verify server-side: the new playlist holds both albums' tracks.
    const list = await (await page.request.get('/api/playlists')).json();
    const pl = (list as Array<{ id: number; name: string; trackCount: number }>).find((p) => p.name === 'Bulk Set');
    expect(pl).toBeTruthy();
    expect(pl!.trackCount).toBe(SEED.albums.debut.tracks + SEED.albums.midnight.tracks);
  });

  test('the table layout offers a select-all checkbox', async ({ page }) => {
    await gotoApp(page);
    await openAlbums(page);
    await page.getByRole('button', { name: 'Table', exact: true }).click();

    await page.locator('.ctable thead .ct-sel input').check();
    // All seeded albums on the page get selected.
    await expect(page.locator('.bulk-count')).toHaveText(`${SEED.counts.albums} selected`);
    await page.locator('.ctable thead .ct-sel input').uncheck();
    await expect(page.locator('.bulk-bar')).toHaveCount(0);
  });
});
