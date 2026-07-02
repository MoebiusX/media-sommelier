import { test, expect } from '@playwright/test';
import { gotoApp, openTab } from './helpers';

/** Saved views (somm.savedViews) and URL-hash view restore (shareable links / reload). */

async function openAlbums(page: import('@playwright/test').Page) {
  await openTab(page, 'Library');
  await page.locator('.lib-tabs button', { hasText: 'Albums' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Albums');
}

test.describe('collection persistence — saved views + hash', () => {
  test('saving a view captures the layout and re-applies it', async ({ page }) => {
    await gotoApp(page);
    await openAlbums(page);

    // Configure: table layout, then save it as a named view.
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(page.locator('.ctable')).toBeVisible();

    page.once('dialog', (d) => d.accept('My Table'));
    await page.getByRole('button', { name: /Views/ }).click();
    await page.locator('.cview-views .atp-item.new').click();

    // Change away from the saved config…
    await page.getByRole('button', { name: 'Grid', exact: true }).click();
    await expect(page.locator('.album-grid')).toBeVisible();

    // …then re-apply the saved view → back to the table.
    await page.getByRole('button', { name: /Views/ }).click();
    await page.locator('.cview-views .atp-item', { hasText: 'My Table' }).click();
    await expect(page.locator('.ctable')).toBeVisible();
  });

  test('a hash link restores the tab and Library view', async ({ page }) => {
    // Directly open a deep link to the Albums view.
    await page.goto('/#t=library&v=albums');
    await expect(page.locator('.sidebar-foot .pill')).toContainText('API connected');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Albums');

    // …and a different tab.
    await page.goto('/#t=playlists');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Playlists');
  });

  test('navigating updates the hash so a reload keeps your place', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');
    await expect.poll(() => page.evaluate(() => location.hash)).toContain('t=overview');

    await page.reload();
    // Restored onto Overview rather than the default Library.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Library Overview');
  });
});
