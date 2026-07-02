import { test, expect } from '@playwright/test';
import { SEED, gotoApp, openPalette } from './helpers';

/**
 * ⌘K command palette (web/src/CommandPalette.tsx). Opens via Ctrl+K (App-level keydown) or the sidebar
 * "Search…" button. It calls the real GET /api/search?q= over the seeded catalog; there is a 150ms
 * debounce before the request fires, so we assert on results appearing (auto-wait) rather than timers.
 *
 * Selectors verified against the component source:
 *   - backdrop:   .cp-backdrop  (closes on mousedown)
 *   - input:      .cp-input     (focused ~30ms after open)
 *   - group hdr:  .cp-group     (text: Artists / Albums / Tracks)
 *   - row:        .cp-row       (highlighted row adds class "on" → .cp-row.on)
 *   - row title:  .cp-title
 *   - empty:      .cp-empty
 * Rows are clickable <div>s (not buttons) → target by visible text / scoped .cp-row locators.
 */
test.describe('command palette (⌘K)', () => {
  test('opens focused with a backdrop and a type-to-search prompt', async ({ page }) => {
    await gotoApp(page);
    await openPalette(page);

    await expect(page.locator('.cp-backdrop')).toBeVisible();
    const input = page.locator('.cp-input');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    // Before typing, the palette invites a query rather than showing results.
    await expect(page.locator('.cp-empty')).toHaveText('Type to search your library.');
  });

  test('opens from the sidebar "Search…" button', async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('.cp-backdrop')).toHaveCount(0);
    await page.locator('.sidebar-search').click();
    await expect(page.locator('.cp-backdrop')).toBeVisible();
    await expect(page.locator('.cp-input')).toBeFocused();
  });

  test('typing an artist name surfaces the artist and its albums', async ({ page }) => {
    await gotoApp(page);
    await openPalette(page);
    // "Testers" matches the artist "The Testers" plus its two albums (Debut, Live Sessions).
    await page.locator('.cp-input').fill('Testers');

    // Artists group label + the artist's own row. The artist name is the row's .cp-title; album rows carry
    // "The Testers" only in their .cp-sub, so scope to .cp-title to disambiguate (an unscoped .cp-row filter
    // matches the two album rows too). (.cp-group is a flat label div, not a container of rows.)
    await expect(page.locator('.cp-group', { hasText: 'Artists' })).toBeVisible();
    await expect(page.locator('.cp-row .cp-title', { hasText: SEED.artists.testers.name })).toBeVisible();

    // Albums group + both seeded Testers albums appear as rows.
    await expect(page.locator('.cp-group', { hasText: 'Albums' })).toBeVisible();
    await expect(page.locator('.cp-row .cp-title', { hasText: SEED.albums.debut.title })).toBeVisible();
    await expect(page.locator('.cp-row .cp-title', { hasText: SEED.albums.live.title })).toBeVisible();
  });

  test('typing a track name surfaces track results', async ({ page }) => {
    await gotoApp(page);
    await openPalette(page);
    // "Wanderer" is a track title (it appears on Debut + Live Sessions as the duplicate group).
    await page.locator('.cp-input').fill(SEED.duplicateTitle);

    await expect(page.locator('.cp-group', { hasText: 'Tracks' })).toBeVisible();
    await expect(
      page.locator('.cp-row .cp-title', { hasText: SEED.duplicateTitle }).first(),
    ).toBeVisible();
  });

  test('shows "No matches." for a query with no results', async ({ page }) => {
    await gotoApp(page);
    await openPalette(page);
    await page.locator('.cp-input').fill('zzzznotathinginthelibrary');
    await expect(page.locator('.cp-empty')).toHaveText('No matches.');
  });

  test('ArrowDown / ArrowUp move the highlighted result', async ({ page }) => {
    await gotoApp(page);
    await openPalette(page);
    await page.locator('.cp-input').fill('Testers');

    // Wait for results to render, then read the first-highlighted row (selection defaults to index 0).
    await expect(page.locator('.cp-row').first()).toBeVisible();
    const firstRow = page.locator('.cp-row').first();
    const secondRow = page.locator('.cp-row').nth(1);

    // Initially the first row carries the "on" highlight class.
    await expect(firstRow).toHaveClass(/\bon\b/);

    // ArrowDown moves the highlight to the second row.
    await page.locator('.cp-input').press('ArrowDown');
    await expect(secondRow).toHaveClass(/\bon\b/);
    await expect(firstRow).not.toHaveClass(/\bon\b/);
    // Exactly one row is highlighted at a time.
    await expect(page.locator('.cp-row.on')).toHaveCount(1);

    // ArrowUp moves it back to the first row.
    await page.locator('.cp-input').press('ArrowUp');
    await expect(firstRow).toHaveClass(/\bon\b/);
    await expect(page.locator('.cp-row.on')).toHaveCount(1);
  });

  test('Escape closes the palette', async ({ page }) => {
    await gotoApp(page);
    await openPalette(page);
    await page.locator('.cp-input').press('Escape');
    await expect(page.locator('.cp-backdrop')).toHaveCount(0);
  });

  test('clicking the backdrop closes the palette', async ({ page }) => {
    await gotoApp(page);
    await openPalette(page);
    // Click near the top-left edge of the backdrop (outside the centered panel) to trigger its mousedown.
    await page.locator('.cp-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.cp-backdrop')).toHaveCount(0);
  });

  test('Enter on an artist result navigates to that artist page', async ({ page }) => {
    await gotoApp(page);
    await openPalette(page);
    await page.locator('.cp-input').fill('Ada');

    // "Ada" → artist "Ada Lovelace" is the first result (artists group is first).
    await expect(
      page.locator('.cp-row', { hasText: SEED.artists.ada.name }).first(),
    ).toBeVisible();
    await expect(page.locator('.cp-row').first()).toHaveClass(/\bon\b/);

    await page.locator('.cp-input').press('Enter');

    // Palette closes and the Library ArtistPage for Ada Lovelace renders.
    await expect(page.locator('.cp-backdrop')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(SEED.artists.ada.name);
    // Breadcrumb "here" crumb confirms we are on the artist page.
    await expect(page.locator('.breadcrumb .here')).toHaveText(SEED.artists.ada.name);
  });

  test('clicking an artist result navigates to that artist page', async ({ page }) => {
    await gotoApp(page);
    await openPalette(page);
    await page.locator('.cp-input').fill('Blue');

    const artistRow = page.locator('.cp-row', { hasText: SEED.artists.blue.name }).first();
    await expect(artistRow).toBeVisible();
    await artistRow.click();

    await expect(page.locator('.cp-backdrop')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(SEED.artists.blue.name);
  });

  test('clicking an album result opens that album page', async ({ page }) => {
    await gotoApp(page);
    await openPalette(page);
    // "Midnight" is a unique album title (Blue Quartet) → matches the album, not an artist.
    await page.locator('.cp-input').fill(SEED.albums.midnight.title);

    const albumRow = page
      .locator('.cp-row', { has: page.locator('.cp-title', { hasText: SEED.albums.midnight.title }) })
      .first();
    await expect(albumRow).toBeVisible();
    await albumRow.click();

    await expect(page.locator('.cp-backdrop')).toHaveCount(0);
    // The Library AlbumPage header shows the album title in its <h1> under .album-head.
    await expect(page.locator('.album-head h1')).toHaveText(SEED.albums.midnight.title);
  });

  test('Enter on a track result plays it (PlayerBar shows the title)', async ({ page }) => {
    await gotoApp(page);
    await openPalette(page);
    // "Signal Fire" is a unique track title (Debut) — no artist/album collision, so it is the first row.
    const trackTitle = 'Signal Fire';
    await page.locator('.cp-input').fill(trackTitle);

    await expect(page.locator('.cp-group', { hasText: 'Tracks' })).toBeVisible();
    await expect(page.locator('.cp-row .cp-title', { hasText: trackTitle }).first()).toBeVisible();
    // The track row is the only result → it is highlighted by default; Enter plays it.
    await expect(page.locator('.cp-row').first()).toHaveClass(/\bon\b/);

    await page.locator('.cp-input').press('Enter');

    // Palette closes and the now-playing PlayerBar surfaces the track title (.player > .player-title).
    await expect(page.locator('.cp-backdrop')).toHaveCount(0);
    await expect(page.locator('.player .player-title')).toHaveText(trackTitle);
  });
});
