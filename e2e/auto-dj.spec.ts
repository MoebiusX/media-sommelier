import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers';

/**
 * Auto DJ picker — opened from the sidebar "Auto DJ" button. The picker calls the real GET /api/dj/moods
 * (seeded genres Rock/Jazz/Electronic/Ambient/Pop classify into moods/styles) and starting a station calls
 * the real POST /api/dj/queue (ordered tracks). Both run against the seeded DB, so no mocking is needed.
 *
 * Assertions are LOOSE where the mood/style set depends on the genre→mood classifier: we only require that
 * at least one selectable vibe exists and that starting one yields a playing track + LIVE state.
 *
 * Starting a station sets player.autoDj, which is process-in-memory state on the shared PlayerProvider. It is
 * not persisted to the backend and resets on reload, so each test re-loads the app (gotoApp) and no server
 * cleanup is required.
 *
 * FIXED DEFECT: the picker used to be unusable from the sidebar — .sidebar is a stacking context
 * (position:relative + z-index, to sit above the app's ambient-bloom pseudo-element), which confined the
 * picker's position:fixed backdrop beneath the rest of the app instead of above it. AutoDjPicker now renders
 * via a React portal to document.body, so it always overlays correctly regardless of where it's mounted.
 */
test.describe('Auto DJ', () => {
  test('opens the picker with a selectable vibe (mood or style)', async ({ page }) => {
    await gotoApp(page);

    // Sidebar "Auto DJ" nav button (a real <button>). Regex name because when a station is live the label
    // becomes "Auto DJ · <label>".
    await page.getByRole('button', { name: /Auto DJ/ }).click();

    // The picker modal is a role=dialog labelled "Auto DJ".
    const dialog = page.getByRole('dialog', { name: 'Auto DJ' });
    await expect(dialog).toBeVisible();

    // "Surprise me" is always offered, plus at least one mood/style chip once moods load.
    await expect(dialog.getByRole('button', { name: /Surprise me/ })).toBeVisible();
    // The classifier produces at least one vibe chip for the seeded genres.
    await expect(dialog.locator('.dj-chip').first()).toBeVisible();
    expect(await dialog.locator('.dj-chip').count()).toBeGreaterThan(0);
  });

  test('shows both mood and style sections', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: /Auto DJ/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Auto DJ' });
    await expect(dialog).toBeVisible();

    await expect(dialog.getByText('By mood', { exact: true })).toBeVisible();
    await expect(dialog.getByText('By style', { exact: true })).toBeVisible();
  });

  test('closing the picker with ✕ hides the dialog', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: /Auto DJ/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Auto DJ' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  });

  test('"Surprise me" starts a station: a track plays and the sidebar shows LIVE', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: /Auto DJ/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Auto DJ' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: /Surprise me/ }).click();

    // Starting a station closes the picker...
    await expect(dialog).toBeHidden();

    // ...the sidebar Auto DJ button gains a LIVE indicator and a station label.
    await expect(page.locator('.nav-item.dj .nav-live')).toHaveText('LIVE');
    await expect(page.locator('.nav-item.dj .nav-label')).toContainText('Auto DJ ·');

    // The PlayerBar now shows a now-playing track (title in .player-title).
    await expect(page.locator('.player-title')).toBeVisible();
    await expect(page.locator('.player-title')).not.toBeEmpty();

    // The now-playing "reason/station" pill shows the station label.
    await expect(page.locator('.dj-pill')).toBeVisible();

    // The sidebar now-playing card appears once a track is current.
    await expect(page.locator('.np-card')).toBeVisible();

    // The <audio> element is actually driving playback (real ~2s WAVs decode in headless Chromium).
    // We assert on player state rather than an exact currentTime.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('audio'));
          return els.some((a) => !!a.currentSrc && !a.paused);
        }),
      )
      .toBe(true);
  });

  test('starting a mood station reflects the chosen station label everywhere', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: /Auto DJ/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Auto DJ' });
    await expect(dialog).toBeVisible();

    // Read the first available vibe chip's label off the DOM (classifier-dependent), then start it.
    const firstChip = dialog.locator('.dj-chip').first();
    await expect(firstChip).toBeVisible();
    const chipLabel = (await firstChip.locator('.dj-chip-label').innerText()).trim();
    expect(chipLabel.length).toBeGreaterThan(0);

    await firstChip.click();
    await expect(dialog).toBeHidden();

    // The station label the queue returns drives the sidebar label and the now-playing pill. The queue's
    // target label may differ from the chip label (server chooses it), so assert LIVE + a non-empty label.
    await expect(page.locator('.nav-item.dj .nav-live')).toHaveText('LIVE');
    const djPill = page.locator('.dj-pill');
    await expect(djPill).toBeVisible();
    await expect(djPill).not.toBeEmpty();

    // A track is playing.
    await expect(page.locator('.player-title')).not.toBeEmpty();
  });

  test('reopening the picker while live offers "Turn off Auto DJ"', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: /Auto DJ/ }).click();
    let dialog = page.getByRole('dialog', { name: 'Auto DJ' });
    await dialog.getByRole('button', { name: /Surprise me/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.nav-item.dj .nav-live')).toHaveText('LIVE');

    // Reopen the picker — now that a station is live it offers a "Turn off Auto DJ" control. Once a track
    // is playing, the PlayerBar grows its OWN "Auto DJ" button too, so scope to the sidebar's nav button
    // (.nav-item.dj) to keep this unambiguous.
    await page.locator('.nav-item.dj').click();
    dialog = page.getByRole('dialog', { name: 'Auto DJ' });
    await expect(dialog).toBeVisible();
    const off = dialog.getByRole('button', { name: /Turn off Auto DJ/ });
    await expect(off).toBeVisible();

    // Turning it off clears the LIVE indicator (the queue keeps playing, it just stops auto-extending).
    await off.click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.nav-item.dj .nav-live')).toHaveCount(0);
    // Intended behavior (player.tsx stopAutoDj): only auto-extend stops — the current queue keeps playing.
    await expect(page.locator('.player-title')).toBeVisible();
  });
});
