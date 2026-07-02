import { test, expect } from '@playwright/test';
import { SEED, gotoApp, openTab, deleteAllPlaylists } from './helpers';

/**
 * Playlists tab — manual + smart playlist lifecycle. MUTATING: the suite runs serially against one shared
 * SQLite catalog, so we wipe playlists before AND after each test and use unique names so parallel edits
 * (should the runner ever change) never collide. All endpoints are local — no network mocking needed.
 */
test.describe('Playlists', () => {
  test.beforeEach(async ({ page }) => {
    await deleteAllPlaylists(page);
  });
  test.afterEach(async ({ page }) => {
    await deleteAllPlaylists(page);
  });

  test('shows the empty state when there are no playlists', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Playlists');
    await expect(
      page.getByText('No playlists yet. Create one above, then add tracks from an album or search.'),
    ).toBeVisible();
  });

  test('creates a manual playlist via the input + Create button', async ({ page }) => {
    const name = `Focus ${Date.now()}`;
    await gotoApp(page);
    await openTab(page, 'Playlists');

    await page.getByPlaceholder('New playlist name — e.g. Road Trip, Focus, Sunday').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    const row = page.locator('.row', { hasText: name });
    await expect(row).toBeVisible();
    // Manual playlists get the ♪ avatar and start at 0 tracks.
    await expect(row.locator('.avatar')).toHaveText('♪');
    await expect(row.locator('.row-sub')).toHaveText('0 tracks');
    // Input is cleared after creation.
    await expect(page.getByPlaceholder('New playlist name — e.g. Road Trip, Focus, Sunday')).toHaveValue('');
  });

  test('creates a manual playlist via the Enter key', async ({ page }) => {
    const name = `Sunday ${Date.now()}`;
    await gotoApp(page);
    await openTab(page, 'Playlists');

    const input = page.getByPlaceholder('New playlist name — e.g. Road Trip, Focus, Sunday');
    await input.fill(name);
    await input.press('Enter');

    await expect(page.locator('.row', { hasText: name })).toBeVisible();
  });

  test('disables the Create button for empty and whitespace-only names', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Playlists');

    const input = page.getByPlaceholder('New playlist name — e.g. Road Trip, Focus, Sunday');
    const createBtn = page.getByRole('button', { name: 'Create', exact: true });

    // Empty → disabled.
    await expect(createBtn).toBeDisabled();
    // Whitespace-only → still disabled.
    await input.fill('   ');
    await expect(createBtn).toBeDisabled();
    // Real text → enabled.
    await input.fill('Real Name');
    await expect(createBtn).toBeEnabled();
  });

  test('opens a playlist to its detail view with breadcrumb and disabled Play at 0 tracks', async ({ page }) => {
    const name = `Roadtrip ${Date.now()}`;
    await gotoApp(page);
    await openTab(page, 'Playlists');

    await page.getByPlaceholder('New playlist name — e.g. Road Trip, Focus, Sunday').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    // Rows are clickable <div>s, not buttons — open by visible name.
    await page.locator('.row', { hasText: name }).click();

    // Breadcrumb: "Playlists / <name>".
    await expect(page.locator('.breadcrumb .crumb')).toHaveText('Playlists');
    await expect(page.locator('.breadcrumb .here')).toHaveText(name);

    // Play is a real button, disabled with an empty playlist; Delete is present.
    await expect(page.getByRole('button', { name: '▶ Play' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();

    // Empty manual playlist shows the add-tracks hint.
    await expect(
      page.getByText('Empty. Add tracks from an album page or the ⌘K search.'),
    ).toBeVisible();
  });

  test('renames a playlist from the detail view and reflects it back in the list', async ({ page }) => {
    const orig = `Old ${Date.now()}`;
    const renamed = `Renamed ${Date.now()}`;
    await gotoApp(page);
    await openTab(page, 'Playlists');

    await page.getByPlaceholder('New playlist name — e.g. Road Trip, Focus, Sunday').fill(orig);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.locator('.row', { hasText: orig }).click();

    // The h1 title (title="Click to rename") turns into an input on click.
    await page.locator('h1[title="Click to rename"]').click();
    const nameInput = page.locator('input.pl-name-input');
    await expect(nameInput).toBeVisible();
    await nameInput.fill(renamed);
    await nameInput.press('Enter');

    // Detail heading + breadcrumb reflect the new name.
    await expect(page.locator('.breadcrumb .here')).toHaveText(renamed);
    await expect(page.locator('h1[title="Click to rename"]')).toHaveText(renamed);

    // Back to the list; the row shows the new name, old name is gone.
    await page.locator('.breadcrumb .crumb').click();
    await expect(page.locator('.row', { hasText: renamed })).toBeVisible();
    await expect(page.locator('.row', { hasText: orig })).toHaveCount(0);
  });

  test('deletes a playlist via the Delete button and returns to the list', async ({ page }) => {
    const name = `Doomed ${Date.now()}`;
    await gotoApp(page);
    await openTab(page, 'Playlists');

    await page.getByPlaceholder('New playlist name — e.g. Road Trip, Focus, Sunday').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.locator('.row', { hasText: name }).click();

    // Delete uses window.confirm — auto-accept it.
    page.on('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Delete' }).click();

    // Back on the list, the row is gone. (Empty state, since the suite starts clean.)
    await expect(page.locator('.breadcrumb')).toHaveCount(0);
    await expect(page.locator('.row', { hasText: name })).toHaveCount(0);
    await expect(
      page.getByText('No playlists yet. Create one above, then add tracks from an album or search.'),
    ).toBeVisible();
  });

  test('creates a smart playlist that matches the 4 lossless seed tracks', async ({ page }) => {
    // FIXED DEFECT: the Lossless rule's value <select> displays "Yes" by default via `value={c.value ||
    // 'true'}` (Playlists.tsx) but the stored condition value stayed '' until the user touched it, so the
    // default rule matched the 12 non-lossless tracks instead of the 4 lossless ones. save() now normalizes
    // an empty lossless/format value to what's displayed before submitting.
    const name = `Lossless ${Date.now()}`;
    await gotoApp(page);
    await openTab(page, 'Playlists');

    // Toggle the smart-playlist rule builder open.
    await page.getByRole('button', { name: '✦ Smart playlist' }).click();
    const builder = page.locator('.rule-builder');
    await expect(builder).toBeVisible();

    // Build the rule: field = Lossless (its value select *displays* "Yes"/true by default).
    await builder.locator('.rb-cond select.sb-input').first().selectOption('lossless');

    // Name the smart playlist and create it.
    await builder.getByPlaceholder('Smart playlist name').fill(name);
    await builder.getByRole('button', { name: 'Create', exact: true }).click();

    // Row appears with the ✦ avatar and a "Smart · N tracks" sub-line. Four seed tracks are lossless.
    const row = page.locator('.row', { hasText: name });
    await expect(row).toBeVisible();
    await expect(row.locator('.avatar')).toHaveText('✦');
    await expect(row.locator('.row-sub')).toHaveText('Smart · 4 tracks', { timeout: 3000 });

    // Open it — detail lists the 4 lossless seed tracks (Wanderer[debut lossless], + Blue Quartet's Midnight).
    await row.click();
    await expect(page.locator('.breadcrumb .here')).toHaveText(name);
    await expect(page.locator('.page-lede')).toContainText('✦ Smart · 4 tracks');

    const tracks = page.locator('.tracks .pl-trk');
    await expect(tracks).toHaveCount(4);
    // The three lossless Blue Quartet tracks + the lossless "Wanderer" from Debut.
    await expect(page.locator('.tracks .pl-trk', { hasText: 'Blue in Green' })).toBeVisible();
    await expect(page.locator('.tracks .pl-trk', { hasText: 'Night Train' })).toBeVisible();
    await expect(page.locator('.tracks .pl-trk', { hasText: 'After Hours' })).toBeVisible();
    await expect(page.locator('.tracks .pl-trk', { hasText: SEED.duplicateTitle })).toBeVisible();

    // Smart-playlist track rows show a FLAC badge for lossless tracks, and have no remove (✕) button.
    await expect(page.locator('.tracks .pl-trk .meta', { hasText: 'FLAC' }).first()).toBeVisible();
    await expect(page.locator('.tracks .pl-trk .pl-remove')).toHaveCount(0);
  });

  test('creates a smart playlist by Genre contains Rock', async ({ page }) => {
    const name = `Rockers ${Date.now()}`;
    await gotoApp(page);
    await openTab(page, 'Playlists');

    await page.getByRole('button', { name: '✦ Smart playlist' }).click();
    const builder = page.locator('.rule-builder');
    await expect(builder).toBeVisible();

    // Field defaults to Genre; op defaults to "contains". Fill the value box with "Rock".
    await builder.locator('.rb-cond select.sb-input').first().selectOption('genre');
    await builder.getByPlaceholder('contains…').fill(SEED.genres[0]); // 'Rock'

    await builder.getByPlaceholder('Smart playlist name').fill(name);
    await builder.getByRole('button', { name: 'Create', exact: true }).click();

    // The two Rock albums (Debut: 3 tracks, Live Sessions: 2 tracks) → 5 Rock tracks in the seed.
    const row = page.locator('.row', { hasText: name });
    await expect(row).toBeVisible();
    await expect(row.locator('.avatar')).toHaveText('✦');
    await expect(row.locator('.row-sub')).toHaveText(
      `Smart · ${SEED.albums.debut.tracks + SEED.albums.live.tracks} tracks`,
    );
  });
});
