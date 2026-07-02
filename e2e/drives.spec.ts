import { test, expect, type Page } from '@playwright/test';
import { SEED, gotoApp, openTab, deleteAllProfiles } from './helpers';

/**
 * Sync / Drives (web/src/Drives.tsx). MUTATING: creates sync profiles, so we wipe all profiles before
 * and after every test and use unique names. Local profile CRUD runs for real against the seeded DB; the
 * actual copy (POST /api/profile/sync + its status/cancel polling) is mocked so no files are ever written.
 */

/** Unique profile name per test to avoid collisions across the serially-shared backend. */
function uniqueName(base: string): string {
  return `${base} ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

/**
 * Look up the id of the profile with the given name via the real API. The sync mocks need to echo the
 * profile's id back as `job.profileId`, because ProfileCard only renders sync UI when
 * `sync.profileId === p.id`.
 */
async function profileIdByName(page: Page, name: string): Promise<number> {
  const res = await page.request.get('/api/profiles');
  const rows = (await res.json()) as Array<{ id: number; name: string }>;
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(`profile "${name}" not found`);
  return row.id;
}

/** Install deterministic mocks for the copy step so sync goes running → done without touching the disk. */
async function mockSync(page: Page, profileId: number): Promise<void> {
  await page.route('**/api/profile/sync', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, job: { state: 'running', profileId, phase: '', done: 0, total: 1 } }),
    });
  });
  await page.route('**/api/profile/sync/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        state: 'done',
        profileId,
        phase: 'done',
        done: 1,
        total: 1,
        result: { copied: 1, skipped: 0, failed: 0, bytes: 1, dest: 'D:/x' },
      }),
    });
  });
  await page.route('**/api/profile/sync/cancel', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
}

test.describe('Sync / Drives', () => {
  test.beforeEach(async ({ page }) => {
    await deleteAllProfiles(page);
  });
  test.afterEach(async ({ page }) => {
    await deleteAllProfiles(page);
  });

  test('shows the empty-profiles state when no profiles exist', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Sync');

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sync to drives');
    await expect(
      page.getByText('No profiles yet. Create one above, then add albums from the Library.'),
    ).toBeVisible();
  });

  test('creating a profile adds it to the list', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Sync');

    const name = uniqueName('Car');
    await page.getByPlaceholder('New profile name — e.g. Car, Audiobooks, Gym').fill(name);
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();

    // The new card renders with the profile name and a zero-album summary.
    const card = page.locator('.profile-card', { hasText: name });
    await expect(card.getByRole('heading', { level: 3 })).toHaveText(name);
    await expect(card.locator('.profile-sub')).toContainText('0 albums');
    // The create input clears after a successful create.
    await expect(page.getByPlaceholder('New profile name — e.g. Car, Audiobooks, Gym')).toHaveValue('');
  });

  test('the Create button is disabled until a name is entered', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Sync');

    const create = page.getByRole('button', { name: 'Create profile', exact: true });
    await expect(create).toBeDisabled();
    await page.getByPlaceholder('New profile name — e.g. Car, Audiobooks, Gym').fill('Gym temp');
    await expect(create).toBeEnabled();
  });

  test('configuring target, preset and transcode persists on the card', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Sync');

    const name = uniqueName('Config');
    await page.getByPlaceholder('New profile name — e.g. Car, Audiobooks, Gym').fill(name);
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();

    const card = page.locator('.profile-card', { hasText: name });
    await expect(card).toBeVisible();

    // Set a target drive/folder (persisted onBlur).
    const target = card.getByPlaceholder(/E:\\/);
    await target.fill('D:/Sommelier/Config');
    await target.blur();

    // Toggle "Convert to MP3 (car)" — the checkbox reflects the new state.
    const transcode = card.locator('label.check input[type="checkbox"]');
    await expect(transcode).not.toBeChecked();
    await transcode.check();
    await expect(transcode).toBeChecked();

    // The value is durable across a reload (persisted server-side).
    await page.reload();
    await gotoApp(page);
    await openTab(page, 'Sync');
    const reloaded = page.locator('.profile-card', { hasText: name });
    await expect(reloaded.getByPlaceholder(/E:\\/)).toHaveValue('D:/Sommelier/Config');
    await expect(reloaded.locator('label.check input[type="checkbox"]')).toBeChecked();
  });

  test('adding a lossless album shows it with size and a playback-risk warning', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Sync');

    const name = uniqueName('Lossless');
    await page.getByPlaceholder('New profile name — e.g. Car, Audiobooks, Gym').fill(name);
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();
    await expect(page.locator('.profile-card', { hasText: name })).toBeVisible();

    // Add albums from the Library in the UI, but the affordance for that lives on album pages, not on the
    // Drives card — so seed the album via the real API and reload to observe it on the card.
    const id = await profileIdByName(page, name);
    const add = await page.request.post('/api/profile/add', { data: { id, albumId: SEED.albums.midnight.id } });
    expect(add.ok()).toBeTruthy();

    await page.reload();
    await gotoApp(page);
    await openTab(page, 'Sync');

    const card = page.locator('.profile-card', { hasText: name });
    // Summary now reflects one album.
    await expect(card.locator('.profile-sub')).toContainText('1 albums');

    // Midnight is all-lossless (3 tracks) → the untranscoded playback-risk warning appears.
    const warn = card.locator('.profile-warn');
    await expect(warn).toBeVisible();
    await expect(warn).toContainText(
      `⚠ ${SEED.albums.midnight.tracks} tracks are lossless/FLAC and may not play on car stereos.`,
    );
    await expect(warn).toContainText('tick "Convert to MP3" to fix');

    // Expand the album list and confirm the album shows with title, artist and a FLAC marker.
    await card.getByRole('button', { name: /Show albums/ }).click();
    const row = card.locator('.pa-row', { hasText: SEED.albums.midnight.title });
    await expect(row.locator('.pa-title')).toHaveText(SEED.albums.midnight.title);
    await expect(row.locator('.pa-sub')).toContainText(SEED.albums.midnight.artist);
    await expect(row.locator('.pa-sub')).toContainText('FLAC');
    await expect(row.locator('.pa-sub')).toContainText(`${SEED.albums.midnight.tracks} tracks`);

    // Ticking transcode flips the warning to the reassuring "will be converted" copy.
    await card.locator('label.check input[type="checkbox"]').check();
    await expect(warn).toContainText(
      `♪ ${SEED.albums.midnight.tracks} lossless/FLAC tracks will be converted to MP3 320k on sync`,
    );
  });

  test('a profile with no albums shows no playback-risk warning', async ({ page }) => {
    // The playback-risk warning is driven by riskTracks (lossless/FLAC/WAV file extensions). A freshly
    // created, empty profile has no tracks → riskTracks 0 → the warning must not appear.
    // (All seeded audio is WAV, itself a "risk" format, so an album-with-no-warning case isn't reproducible
    // from this fixture — the meaningful no-warning case is an empty profile.)
    await gotoApp(page);
    await openTab(page, 'Sync');

    const name = uniqueName('Empty');
    await page.getByPlaceholder('New profile name — e.g. Car, Audiobooks, Gym').fill(name);
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();

    const card = page.locator('.profile-card', { hasText: name });
    await expect(card).toBeVisible();
    await expect(card.locator('.profile-sub')).toContainText('0 albums');
    await expect(card.locator('.profile-warn')).toHaveCount(0);
  });

  test('Sync now is disabled with no target or no albums, then runs to a done summary', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Sync');

    const name = uniqueName('Sync');
    await page.getByPlaceholder('New profile name — e.g. Car, Audiobooks, Gym').fill(name);
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();
    await expect(page.locator('.profile-card', { hasText: name })).toBeVisible();

    // Fresh profile has no target and no albums → Sync now is disabled.
    let card = page.locator('.profile-card', { hasText: name });
    await expect(card.getByRole('button', { name: 'Sync now', exact: true })).toBeDisabled();

    // Give it a target and one album so Sync now becomes enabled.
    const id = await profileIdByName(page, name);
    await page.request.post('/api/profiles/update', { data: { id, target: 'D:/x' } });
    await page.request.post('/api/profile/add', { data: { id, albumId: SEED.albums.roadtrip.id } });

    await mockSync(page, id);

    await page.reload();
    await gotoApp(page);
    await openTab(page, 'Sync');
    card = page.locator('.profile-card', { hasText: name });

    const syncBtn = card.getByRole('button', { name: 'Sync now', exact: true });
    await expect(syncBtn).toBeEnabled();
    await syncBtn.click();

    // Progress UI appears while running (the mocked job starts in the running state).
    await expect(card.locator('.spinner-sm')).toBeVisible();

    // Poll resolves to done → the success summary line renders (copied 1 / skipped 0).
    await expect(card.locator('.ok-text')).toContainText('✓ 1 synced');
    await expect(card.locator('.ok-text')).toContainText('skipped 0');
  });

  test('deleting a profile removes its card', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Sync');

    const name = uniqueName('Delete');
    await page.getByPlaceholder('New profile name — e.g. Car, Audiobooks, Gym').fill(name);
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();
    const card = page.locator('.profile-card', { hasText: name });
    await expect(card).toBeVisible();

    // Delete is guarded by a native confirm() — auto-accept it.
    page.once('dialog', (d) => void d.accept());
    await card.getByRole('button', { name: '✕' }).first().click();

    await expect(page.locator('.profile-card', { hasText: name })).toHaveCount(0);
  });
});
