import { test, expect } from '@playwright/test';
import { SEED, gotoApp, openTab } from './helpers';

/**
 * The reusable collection toolbar (web/src/collection/**): layout switch (grid/list/table), table
 * click-to-sort, faceted filters with live counts, density, cover-size, and per-view persistence. Runs
 * against the seeded catalog in client mode — no backend/API changes needed for the Albums surface.
 */

/** Open the Albums browse sub-view (its Artists|Albums switch lives in .lib-tabs). */
async function openAlbums(page: import('@playwright/test').Page) {
  await openTab(page, 'Library');
  await page.locator('.lib-tabs button', { hasText: 'Albums' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Albums');
}

test.describe('collection toolbar — layouts / sort / facets', () => {
  test('albums default to the grid and switch between grid, list and table layouts', async ({ page }) => {
    await gotoApp(page);
    await openAlbums(page);

    // Default layout is the grid.
    await expect(page.locator('.album-grid')).toBeVisible();
    await expect(page.locator('.ctable')).toHaveCount(0);

    // → List.
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await expect(page.locator('.list .row').first()).toBeVisible();
    await expect(page.locator('.album-grid')).toHaveCount(0);

    // → Table.
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(page.locator('.ctable')).toBeVisible();
    await expect(page.locator('.ctable thead th', { hasText: 'Album' })).toBeVisible();
    await expect(page.locator('.ctable tbody tr')).toHaveCount(SEED.counts.albums);
  });

  test('table header click sorts, sets aria-sort, and reverses on a second click', async ({ page }) => {
    await gotoApp(page);
    await openAlbums(page);
    await page.getByRole('button', { name: 'Table', exact: true }).click();

    const yearHeader = page.locator('.ctable thead th', { hasText: 'Year' });
    await yearHeader.click();
    // Ascending by year → the 1999 "Midnight" is the first row.
    await expect(yearHeader).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.locator('.ctable tbody tr').first()).toContainText(SEED.albums.midnight.title);

    // Second click reverses → the 2020 "Drift" is first.
    await yearHeader.click();
    await expect(yearHeader).toHaveAttribute('aria-sort', 'descending');
    await expect(page.locator('.ctable tbody tr').first()).toContainText(SEED.albums.drift.title);
  });

  test('a Quality facet narrows the grid to lossless albums with a live count', async ({ page }) => {
    await gotoApp(page);
    await openAlbums(page);

    // Open the Filters popover and pick Quality → Lossless (only "Midnight" is all-lossless).
    await page.getByRole('button', { name: /Filters/ }).click();
    const popover = page.locator('.cview-filters');
    await expect(popover).toBeVisible();
    const lossless = popover.locator('.decade', { hasText: 'Lossless' });
    await expect(lossless).toContainText('1'); // live facet count
    await lossless.click();

    // Grid narrows to the single lossless album; an active-filter chip appears.
    await expect(page.locator('.album-card')).toHaveCount(1);
    await expect(page.locator('.album-card')).toContainText(SEED.albums.midnight.title);
    await expect(page.locator('.cview-active-chip', { hasText: 'Lossless' })).toBeVisible();
    await expect(page.locator('.list-count')).toContainText('Showing 1 of 1 albums');

    // Clearing restores the full grid.
    await page.locator('.cview-clear-inline').click();
    await expect(page.locator('.album-card')).toHaveCount(SEED.counts.albums);
  });

  test('the pinned decade strip single-selects a decade', async ({ page }) => {
    await gotoApp(page);
    await openAlbums(page);
    // The pinned decade chips render outside the popover (like the old strip).
    await page.locator('.decade-chips button', { hasText: '2000s' }).first().click();
    // 2001 "Debut" + 2003 "Live Sessions" are the seeded 2000s albums.
    await expect(page.locator('.album-card')).toHaveCount(2);
    await expect(page.locator('.album-card', { hasText: SEED.albums.debut.title })).toBeVisible();
  });

  test('compact density condenses the list, and cover-size drives --cover-min', async ({ page }) => {
    await gotoApp(page);
    await openAlbums(page);

    // Cover-size slider (grid only) sets --cover-min on the grid.
    const size = page.locator('.cview-size');
    await size.evaluate((el) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '240');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('.album-grid')).toHaveAttribute('style', /--cover-min:\s*240px/);

    // Compact density on the list layout applies .list.compact.
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await page.getByRole('button', { name: 'Compact', exact: true }).click();
    await expect(page.locator('.list.compact')).toBeVisible();
  });

  test('layout choice persists across a reload (somm.view.albums)', async ({ page }) => {
    await gotoApp(page);
    await openAlbums(page);
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(page.locator('.ctable')).toBeVisible();

    await page.reload();
    await openAlbums(page);
    // The persisted layout is restored without touching the toolbar.
    await expect(page.locator('.ctable')).toBeVisible();
  });

  test('artists can be faceted by genre (enriched /api/artists)', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Library'); // lands on Artists (default list layout)

    await page.getByRole('button', { name: /Filters/ }).click();
    const popover = page.locator('.cview-filters');
    await expect(popover).toBeVisible();

    // Only The Testers has Rock tracks in the seed → filtering Genre: Rock leaves one artist.
    await popover.locator('.decade', { hasText: 'Rock' }).click();
    await expect(page.locator('.list .row')).toHaveCount(1);
    await expect(page.locator('.list .row')).toContainText(SEED.artists.testers.name);
  });

  test('artists get the toolbar too — table layout with sortable columns', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Library'); // lands on Artists

    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(page.locator('.ctable thead th', { hasText: 'Artist' })).toBeVisible();
    await expect(page.locator('.ctable tbody tr')).toHaveCount(SEED.counts.artists);

    // Sort by Artist name ascending → "Ada Lovelace" first.
    const nameHeader = page.locator('.ctable thead th', { hasText: 'Artist' });
    await nameHeader.click();
    await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.locator('.ctable tbody tr').first()).toContainText(SEED.artists.ada.name);
  });
});
