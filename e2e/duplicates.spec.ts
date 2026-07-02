import { test, expect } from '@playwright/test';
import { SEED, gotoApp, openTab, deleteAllPlaylists } from './helpers';

/**
 * Duplicates panel (web/src/Duplicates.tsx), mounted inside the Overview page.
 *
 * The panel starts in an intro state and only fetches GET /api/duplicates when the user clicks
 * "Find duplicates". /api/duplicates is REAL (reads the seeded SQLite catalog) — no mocking. The seed
 * (e2e/seed.ts) is designed to yield exactly ONE duplicate group: 'Wanderer' by 'The Testers', with two
 * copies — the lossless Debut rip (keeper) and the lossy 192k Live rip (the wasted extra).
 */

const DUP_ARTIST = SEED.artists.testers.name; // 'The Testers'
const DUP_TITLE = SEED.duplicateTitle; // 'Wanderer'

/** Trigger the scan and wait for the results (headline) to render. */
async function findDuplicates(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Find duplicates' }).click();
  await expect(page.locator('.dup-headline')).toBeVisible();
}

test.describe('Duplicates panel', () => {
  test('shows an intro with a "Find duplicates" button before scanning', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');

    const panel = page.locator('.panel', { hasText: 'Duplicate tracks' });
    await expect(panel).toBeVisible();
    await expect(panel.locator('.panel-title')).toContainText('Duplicate tracks');
    await expect(page.getByRole('button', { name: 'Find duplicates' })).toBeVisible();
    // No results are shown until the scan runs.
    await expect(page.locator('.dup-headline')).toHaveCount(0);
    await expect(page.locator('.dup-group')).toHaveCount(0);
  });

  test('scanning surfaces the single seeded duplicate group with a wasted-space figure', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');
    await findDuplicates(page);

    // Exactly one duplicate group exists in the seed.
    const groups = page.locator('.dup-group');
    await expect(groups).toHaveCount(1);

    // Headline: "1 duplicated songs" and a non-zero reclaimable byte figure.
    const headline = page.locator('.dup-headline');
    await expect(headline).toContainText('1');
    await expect(headline).toContainText('duplicated songs');
    await expect(headline).toContainText('reclaimable');
    // The reclaimable amount renders in the .ok-text span and is a byte figure (MB from the ~9MB extra).
    await expect(headline.locator('.ok-text')).toContainText('MB');

    // The group names the duplicated song and its artist.
    const head = groups.first().locator('.dup-group-head');
    await expect(head.locator('.dup-name')).toContainText(`${DUP_ARTIST} — ${DUP_TITLE}`);
  });

  test('the group badge shows the copy count (×2) and a per-group wasted-bytes figure', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');
    await findDuplicates(page);

    const badges = page.locator('.dup-group').first().locator('.dup-badges');
    // ×2 — the seed has two copies of 'Wanderer'.
    await expect(badges.locator('.badge.multi')).toHaveText('×2');
    // A second badge reports the reclaimable space for this group.
    await expect(badges).toContainText('extra');
    await expect(badges).toContainText('MB');
  });

  test('expanding the group reveals both copies with exactly one keeper', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');
    await findDuplicates(page);

    const group = page.locator('.dup-group').first();
    // Files are hidden until the head is clicked (the head is a clickable <div>, not a button).
    await expect(group.locator('.dup-files')).toHaveCount(0);
    await group.locator('.dup-group-head').click();

    const files = group.locator('.dup-file');
    await expect(files).toHaveCount(2);

    // Exactly one copy is the keeper (has the .keep class and a green "keep" badge); the other is "extra".
    await expect(group.locator('.dup-file.keep')).toHaveCount(1);
    await expect(group.locator('.dup-file .badge.good')).toHaveCount(1);
    await expect(group.locator('.dup-file .badge.good')).toHaveText('keep');
    await expect(group.locator('.dup-file .badge.dim')).toHaveCount(1);
    await expect(group.locator('.dup-file .badge.dim')).toHaveText('extra');
  });

  test('the lossless copy is the keeper and shows a FLAC quality label', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');
    await findDuplicates(page);

    const group = page.locator('.dup-group').first();
    await group.locator('.dup-group-head').click();

    // The keeper row is the lossless one → labelled FLAC (Duplicates.tsx renders 'FLAC' when t.lossless).
    const keeper = group.locator('.dup-file.keep');
    await expect(keeper).toHaveCount(1);
    await expect(keeper.locator('.dup-fmt')).toHaveText('FLAC');

    // The non-keeper (extra) copy is the lossy 192k rip → shows its uppercased ext + bitrate, not FLAC.
    const extra = group.locator('.dup-file:not(.keep)');
    await expect(extra).toHaveCount(1);
    await expect(extra.locator('.dup-fmt')).toContainText('192k');
    await expect(extra.locator('.dup-fmt')).not.toHaveText('FLAC');
  });

  test('both copies show their format, size and duration details', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');
    await findDuplicates(page);

    const group = page.locator('.dup-group').first();
    await group.locator('.dup-group-head').click();

    const files = group.locator('.dup-file');
    await expect(files).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      const row = files.nth(i);
      await expect(row.locator('.dup-fmt')).not.toBeEmpty();
      await expect(row.locator('.dup-size')).toContainText('MB');
      await expect(row.locator('.dup-dur')).not.toBeEmpty();
      // The full source path is shown for each copy.
      await expect(row.locator('.dup-path')).not.toBeEmpty();
    }
  });

  test('playing a copy from the group starts playback in the PlayerBar', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Overview');
    await findDuplicates(page);

    const group = page.locator('.dup-group').first();
    await group.locator('.dup-group-head').click();

    // The per-file ▶ is a real <button title="Play">; clicking it queues that copy.
    await group.locator('.dup-file').first().locator('button.dup-play').click();

    // Observable: the PlayerBar (renders only once a track is current) shows the now-playing title.
    await expect(page.locator('.player .player-title')).toHaveText(DUP_TITLE);
  });

  test('collects the non-keeper extras into a playlist', async ({ page }) => {
    await deleteAllPlaylists(page);
    await gotoApp(page);
    await openTab(page, 'Overview');
    await findDuplicates(page);

    // One duplicate group → one non-keeper copy (the lossy Live "Wanderer").
    const actions = page.locator('.dup-actions');
    await expect(actions.getByRole('button', { name: /Collect 1 extras/ })).toBeVisible();

    page.once('dialog', (d) => d.accept('Extras'));
    await actions.getByRole('button', { name: /Collect 1 extras/ }).click();
    await actions.locator('.atp-menu .atp-item.new').click();
    await expect(actions).toContainText('Added 1 extras to Extras');

    // The new playlist holds exactly the one non-keeper copy.
    const list = (await (await page.request.get('/api/playlists')).json()) as Array<{ name: string; trackCount: number }>;
    expect(list.find((p) => p.name === 'Extras')?.trackCount).toBe(1);
    await deleteAllPlaylists(page);
  });
});
