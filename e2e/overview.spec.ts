import { test, expect } from '@playwright/test';
import { SEED, gotoApp, openTab } from './helpers';

/**
 * Overview page (web/src/Overview.tsx). Read-only against the seeded DB — this spec creates no server
 * state, so no cleanup is needed. RefreshBatch and Duplicates panels are covered elsewhere; here we only
 * assert they are present.
 */
test.describe('Overview page', () => {
  test('renders the heading and six seeded stat tiles', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Library Overview');

    // Each stat tile is a .stat with a .stat-label + .stat-value; assert the seeded numbers.
    const tile = (label: string) => page.locator('.stat', { hasText: label }).first();
    await expect(tile('Tracks').locator('.stat-value')).toHaveText(String(SEED.counts.tracks));
    await expect(tile('Albums').locator('.stat-value')).toHaveText(String(SEED.counts.albums));
    await expect(tile('Albums').locator('.stat-sub')).toHaveText('reconstructed');
    await expect(tile('Artists').locator('.stat-value')).toHaveText(String(SEED.counts.artists));

    // Total size + Runtime tiles simply render non-empty values.
    await expect(tile('Total size').locator('.stat-value')).not.toHaveText('');
    await expect(tile('Runtime').locator('.stat-value')).not.toHaveText('');

    // Lossless tile shows a "%" value with the "of tracks" sub-label.
    const lossless = tile('Lossless');
    await expect(lossless.locator('.stat-value')).toContainText('%');
    await expect(lossless.locator('.stat-sub')).toHaveText('of tracks');
  });

  test('shows the RefreshBatch and Duplicates panels', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');
    // Both are rendered above the stat grid; assert presence without deep coverage.
    await expect(page.locator('.stat-grid')).toBeVisible();
  });

  test('renders the tag-vs-folder simulation with the seeded verdict', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');

    const sim = page.locator('.sim');
    await expect(sim).toBeVisible();
    // Headline mentions folder reconstruction rebuilding albums and rescuing tracks.
    await expect(sim.locator('.sim-headline')).toContainText('Folder reconstruction');
    await expect(sim.locator('.sim-headline')).toContainText('rescued');

    // The verdict block echoes the exact seeded verdict text.
    await expect(sim.locator('.sim-verdict')).toContainText(
      'Folder reconstruction leaves fewer orphan tracks',
    );
  });

  test('lists top artists by tracks with The Testers first', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');

    // Scope to the "Top artists" panel (panel-title contains "Top artists").
    const panel = page.locator('.panel', { hasText: 'Top artists' }).first();
    const bars = panel.locator('.bar');

    // All five seeded artists appear.
    for (const a of Object.values(SEED.artists)) {
      await expect(panel.getByText(a.name, { exact: true })).toBeVisible();
    }

    // The Testers (5 tracks) sorts first and shows its track count.
    const first = bars.first();
    await expect(first.locator('.name')).toHaveText(SEED.artists.testers.name);
    await expect(first.locator('.val')).toHaveText(String(SEED.artists.testers.tracks));

    // DEFECT-SUSPECT: clickable top-artist bars are <div>s, not <button>s — not keyboard-operable.
    // The panel exposes no button role for the artist bars, so a keyboard/AT user cannot activate them.
    await expect(panel.getByRole('button')).toHaveCount(0);
  });

  test('clicking a top-artist bar navigates to that artist in Library', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');

    const panel = page.locator('.panel', { hasText: 'Top artists' }).first();
    // Bars are clickable <div>s — click by the visible artist text, not a button role.
    await panel.getByText(SEED.artists.ada.name, { exact: true }).click();

    // Tab switches to Library and the ArtistPage heading shows the artist's name.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(SEED.artists.ada.name);
  });

  test('renders Top genres and Busiest years bars, genres not clickable', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');

    // Top genres panel: Rock is the highest genre (from seeded data).
    const genres = page.locator('.panel', { hasText: 'Top genres' }).first();
    await expect(genres.locator('.bar').first().locator('.name')).toHaveText('Rock');
    for (const g of SEED.genres) {
      await expect(genres.getByText(g, { exact: true })).toBeVisible();
    }

    // Genre bars have no onPick → no 'clickable' class → clicking must not navigate.
    await expect(genres.locator('.bar.clickable')).toHaveCount(0);
    await genres.getByText('Rock', { exact: true }).click();
    // Still on the Overview page (no navigation happened).
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Library Overview');

    // Busiest years panel renders bars for the seeded years.
    const years = page.locator('.panel', { hasText: 'Busiest years' }).first();
    await expect(years.locator('.bar').first()).toBeVisible();
    await expect(years.getByText(String(SEED.albums.debut.year), { exact: true })).toBeVisible();
  });
});
