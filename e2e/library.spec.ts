import { test, expect } from '@playwright/test';
import { SEED, gotoApp, openTab, deleteAllPlaylists } from './helpers';

/**
 * Library LIST/BROWSE surfaces: the artists list, artist search, artist page album grid,
 * the Albums browse view (filter/sort/decade chips/flag badges/covers), and the album-card
 * "Add to playlist" menu outside-click behavior. Album-DETAIL playback/refresh lives in a
 * separate spec. All flows here read the seeded DB — no network endpoints to mock.
 */
test.describe('Library — list & browse', () => {
  /* ---------------------------------- Artists list ---------------------------------- */

  test('artists list renders every seeded artist with a "{n} tracks · {m} albums" sub', async ({ page }) => {
    await gotoApp(page); // Library is the default landing tab.

    // The count line reflects the seeded artist total.
    await expect(page.locator('.list-count')).toContainText(String(SEED.counts.artists));

    // Every seeded artist appears as a row with the expected "N tracks · M albums" sub.
    for (const a of Object.values(SEED.artists)) {
      const row = page.locator('.row', { hasText: a.name });
      await expect(row).toBeVisible();
      await expect(row.locator('.row-title')).toHaveText(a.name);
      const albumWord = a.albums === 1 ? 'album' : 'albums';
      await expect(row.locator('.row-sub')).toHaveText(`${a.tracks} tracks · ${a.albums} ${albumWord}`);
    }
  });

  test('searching artists filters the list and updates the count', async ({ page }) => {
    await gotoApp(page);

    await page.getByPlaceholder('Search artists…').fill('Testers');

    // Only The Testers survives; the other seeded artists are gone.
    await expect(page.locator('.row', { hasText: SEED.artists.testers.name })).toBeVisible();
    await expect(page.locator('.row', { hasText: SEED.artists.ada.name })).toHaveCount(0);
    await expect(page.locator('.list-count')).toContainText('Showing 1 of 1');
  });

  test('a no-match search shows the empty state', async ({ page }) => {
    await gotoApp(page);

    await page.getByPlaceholder('Search artists…').fill('zzzz');
    await expect(page.locator('.empty')).toHaveText('No artists match “zzzz”.');
  });

  test('clicking an artist row opens the artist page with breadcrumb and album grid', async ({ page }) => {
    await gotoApp(page);

    // Artist rows are clickable DIVs — click by visible text, scoped to the row.
    await page.locator('.row', { hasText: SEED.artists.testers.name }).click();

    // Breadcrumb reads "Library / {name}".
    await expect(page.locator('.breadcrumb .crumb')).toHaveText('Library');
    await expect(page.locator('.breadcrumb .here')).toHaveText(SEED.artists.testers.name);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(SEED.artists.testers.name);

    // The Testers has two albums — both cards render in the grid.
    const grid = page.locator('.album-grid');
    await expect(grid.locator('.album-card')).toHaveCount(SEED.artists.testers.albums);
    await expect(grid.getByText(SEED.albums.debut.title, { exact: true })).toBeVisible();
    await expect(grid.getByText(SEED.albums.live.title, { exact: true })).toBeVisible();
  });

  /* ---------------------------------- Albums browse ---------------------------------- */

  test('the Albums sub-tab shows the AlbumsBrowse view with a reconstructed-count lede', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: 'Albums', exact: true }).click();

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Albums');
    await expect(page.locator('.page-lede')).toHaveText(`${SEED.counts.albums} reconstructed albums`);
    await expect(page.locator('.album-grid .album-card')).toHaveCount(SEED.counts.albums);
  });

  test('the albums filter box narrows the grid', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: 'Albums', exact: true }).click();

    await page.getByPlaceholder('Filter albums…').fill('Midnight');

    const grid = page.locator('.album-grid');
    await expect(grid.locator('.album-card')).toHaveCount(1);
    await expect(grid.getByText(SEED.albums.midnight.title, { exact: true })).toBeVisible();
    await expect(page.locator('.list-count')).toContainText('Showing 1 of 1 albums');
  });

  test('sorting by Newest puts the most recent album first', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: 'Albums', exact: true }).click();

    // Default sort is Artist; switch the sort <select> to "Sort: Newest" (value=year).
    await page.locator('select.sb-input').selectOption('year');

    // The newest seeded album is Drift (2020) — it should sort to the first card.
    const firstCard = page.locator('.album-grid .album-card').first();
    await expect(firstCard.locator('.album-name')).toHaveText(SEED.albums.drift.title);
    await expect(firstCard.locator('.album-line')).toContainText(String(SEED.albums.drift.year));
  });

  test('decade chips filter the grid to that decade', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: 'Albums', exact: true }).click();

    // Pick the 2000s decade — Debut (2001) and Live Sessions (2003) qualify; 2010s/1990s/2020s do not.
    await page.locator('.decade-chips button', { hasText: '2000s' }).click();

    const grid = page.locator('.album-grid');
    await expect(grid.locator('.album-card')).toHaveCount(2);
    await expect(grid.getByText(SEED.albums.debut.title, { exact: true })).toBeVisible();
    await expect(grid.getByText(SEED.albums.live.title, { exact: true })).toBeVisible();
    await expect(grid.getByText(SEED.albums.drift.title, { exact: true })).toHaveCount(0);
  });

  /* ------------------------------- Flag badges & covers ------------------------------- */

  test('flag badges render per album (FLAC / compilation / needs review)', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: 'Albums', exact: true }).click();

    const cardFor = (title: string) => page.locator('.album-card', { hasText: title });

    // Midnight is all-lossless → a FLAC badge.
    await expect(cardFor(SEED.albums.midnight.title).locator('.badge.flac')).toHaveText('FLAC');
    // Road Trip Mix carries possible-compilation → "compilation".
    await expect(cardFor(SEED.albums.roadtrip.title).locator('.badge', { hasText: 'compilation' })).toBeVisible();
    // Live Sessions carries needs-review → "needs review".
    await expect(cardFor(SEED.albums.live.title).locator('.badge', { hasText: 'needs review' })).toBeVisible();
  });

  test('an album with a real cover shows an <img>; one without falls back to initials', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: 'Albums', exact: true }).click();

    // Debut is the one seeded album with a real cover override → the .cover renders an <img>.
    const debutCover = page.locator('.album-card', { hasText: SEED.albums.debut.title }).locator('.cover');
    await expect(debutCover.locator('img')).toBeVisible();
    await expect(debutCover.locator('.cover-fallback')).toHaveCount(0);

    // Drift has no cover → the <img> onError swaps in the initials fallback ("D").
    const driftCover = page.locator('.album-card', { hasText: SEED.albums.drift.title }).locator('.cover');
    await expect(driftCover.locator('.cover-fallback')).toBeVisible();
    await expect(driftCover.locator('.cover-fallback')).toHaveText('D');
  });

  /* --------------------------- Add-to-playlist menu (album card) --------------------------- */

  test.describe('album-card "Add to playlist" menu', () => {
    test.beforeEach(async ({ page }) => {
      await deleteAllPlaylists(page);
    });
    test.afterEach(async ({ page }) => {
      await deleteAllPlaylists(page);
    });

    test('clicking outside the open menu closes it', async ({ page }) => {
      // FIXED DEFECT: AddToPlaylistButton (Library.tsx) had no outside-click handler, so the .atp-menu
      // stayed open until an item was chosen. It now uses the shared useClickOutside hook (ui.tsx).
      await gotoApp(page);
      // Open an artist page so the compact playlist add lives on the tracks — but the album cards
      // expose the ghost "+ Add to playlist ▾" button too on the album detail. Here we exercise the
      // browse grid: navigate to an album detail's add menu is out of scope, so drive it on the
      // AlbumPage's own control instead. We reach an album detail via a card.
      await page.locator('.row', { hasText: SEED.artists.blue.name }).click();
      await page.locator('.album-card', { hasText: SEED.albums.midnight.title }).click();

      // The "+ Add to playlist ▾" button on the album head opens the menu.
      await page.getByRole('button', { name: '+ Add to playlist ▾' }).click();
      await expect(page.locator('.atp-menu')).toBeVisible();

      // Click a neutral area elsewhere on the page. A user expects the open menu to dismiss.
      await page.locator('.album-head h1').click();
      await expect(page.locator('.atp-menu')).toBeHidden({ timeout: 3000 });
    });
  });
});
