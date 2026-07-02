/**
 * PlayerBar + AudioSettings + Lyrics E2E.
 *
 * Playback is started from the Debut album (Library → Albums → "Debut" card → "Play album"). The seeded
 * WAVs are real ~2s files, so playback actually runs in headless Chromium and we assert on observable UI
 * (PlayerBar title, play/pause aria-label) and, where needed, the live <audio> element via page.evaluate.
 *
 * Nothing here creates durable server state, so no playlist/profile cleanup is required. Volume / EQ /
 * night / crossfade persist to localStorage in the page, which is a fresh context per test.
 */
import { test, expect, type Page } from '@playwright/test';
import { SEED, gotoApp, openTab } from './helpers';

/** The Debut album — one album with a real cover; its first track is the keeper "Wanderer". */
const DEBUT = SEED.albums.debut;
// The seed exposes track titles only as a count; the album's first/keeper track is the duplicate "Wanderer".
const FIRST_TRACK = SEED.duplicateTitle; // 'Wanderer'

/** Read the live <audio>.paused for the element currently driving the PlayerBar (the non-paused one, else A). */
async function audioPaused(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('audio')) as HTMLAudioElement[];
    // The active element is the one that has a src and is playing; fall back to the first with a src.
    const playing = els.find((e) => e.src && !e.paused);
    const withSrc = els.find((e) => e.src);
    return (playing ?? withSrc)?.paused ?? true;
  });
}

/** currentTime of the active (playing, else first-with-src) <audio> element. */
async function audioCurrentTime(page: Page): Promise<number> {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('audio')) as HTMLAudioElement[];
    const playing = els.find((e) => e.src && !e.paused);
    const withSrc = els.find((e) => e.src);
    return (playing ?? withSrc)?.currentTime ?? 0;
  });
}

/** Navigate to the Debut album detail page and start "Play album". Returns after the PlayerBar shows a track. */
async function playDebut(page: Page): Promise<void> {
  await openTab(page, 'Library');
  // The Artists|Albums switch lives in .lib-tabs; scope to it so we don't hit the sidebar "Albums" stat text.
  await page.locator('.lib-tabs button', { hasText: 'Albums' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Albums');
  // Album cards are clickable <div>s (.album-card) — target by the visible album title.
  await page.locator('.album-card', { hasText: DEBUT.title }).click();
  // On the album detail page, "Play album" is a real <button>.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(DEBUT.title);
  await page.getByRole('button', { name: 'Play album' }).click();
  // PlayerBar renders once a track is loaded; it shows the first track title ("Wanderer").
  await expect(page.locator('.player .player-title')).toHaveText(FIRST_TRACK);
}

test.describe('Player — transport, audio settings, lyrics', () => {
  test('Play album starts playback and shows the first track in the PlayerBar', async ({ page }) => {
    await gotoApp(page);
    await playDebut(page);

    await expect(page.locator('.player .player-title')).toHaveText(FIRST_TRACK);
    await expect(page.locator('.player .player-artist')).toContainText(DEBUT.artist);
    // Once playing, the transport button offers "Pause".
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
    await expect.poll(() => audioPaused(page)).toBe(false);
  });

  test('pause and resume toggle both the button state and the <audio> element', async ({ page }) => {
    await gotoApp(page);
    await playDebut(page);

    await expect.poll(() => audioPaused(page)).toBe(false);

    // The transport play/pause toggle lives in the PlayerBar (.pbtn.play), whose aria-label flips
    // Play↔Pause. Scope to .player so we don't collide with "Play album" / the "Playlists" nav button.
    const transport = page.locator('.player button.pbtn.play');

    // Pause.
    await transport.click();
    await expect(transport).toHaveAttribute('aria-label', 'Play');
    await expect.poll(() => audioPaused(page)).toBe(true);

    // Resume.
    await transport.click();
    await expect(transport).toHaveAttribute('aria-label', 'Pause');
    await expect.poll(() => audioPaused(page)).toBe(false);
  });

  test('Space toggles play/pause when focus is not in an input', async ({ page }) => {
    await gotoApp(page);
    await playDebut(page);
    await expect.poll(() => audioPaused(page)).toBe(false);

    const transport = page.locator('.player button.pbtn.play');
    // Blur any focused control so Space hits the window keydown handler (not a button's own activation).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Space');
    await expect(transport).toHaveAttribute('aria-label', 'Play');
    await expect.poll(() => audioPaused(page)).toBe(true);

    await page.keyboard.press('Space');
    await expect(transport).toHaveAttribute('aria-label', 'Pause');
    await expect.poll(() => audioPaused(page)).toBe(false);
  });

  test('Next and Previous change the now-playing title', async ({ page }) => {
    await gotoApp(page);
    await playDebut(page);
    const title = page.locator('.player .player-title');
    await expect(title).toHaveText(FIRST_TRACK);

    // Next advances to a different track (Debut has 3 tracks).
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(title).not.toHaveText(FIRST_TRACK);
    const second = (await title.textContent())?.trim() ?? '';
    expect(second.length).toBeGreaterThan(0);

    // Next again → a third, different title.
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(title).not.toHaveText(second);

    // Previous walks back to the second track.
    await page.getByRole('button', { name: 'Previous' }).click();
    await expect(title).toHaveText(second);
  });

  test('Previous is disabled on the first track', async ({ page }) => {
    await gotoApp(page);
    await playDebut(page);
    // Index 0 → Previous disabled.
    await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  test('volume slider persists to localStorage somm.volume', async ({ page }) => {
    await gotoApp(page);
    await playDebut(page);

    const vol = page.locator('.player input.vol');
    await expect(vol).toBeVisible();
    await vol.fill('0.42');
    // setVolume writes the clamped slider value to localStorage.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('somm.volume')))
      .toBe('0.42');
    // And the slider reflects it.
    await expect(vol).toHaveValue('0.42');
  });

  test('repeat toggle adds the active class and re-toggles off', async ({ page }) => {
    await gotoApp(page);
    await playDebut(page);

    const repeat = page.getByRole('button', { name: 'Repeat' });
    await expect(repeat).not.toHaveClass(/\bon\b/);
    await repeat.click();
    await expect(repeat).toHaveClass(/\bon\b/);
    await expect(repeat).toHaveAttribute('title', 'Repeat: on');
    await repeat.click();
    await expect(repeat).not.toHaveClass(/\bon\b/);
  });

  test('shuffle does not crash and preserves the queue length', async ({ page }) => {
    await gotoApp(page);
    await playDebut(page);

    // Open the queue popover to observe queue length (Debut = 3 tracks).
    await page.getByRole('button', { name: 'Queue' }).click();
    const rows = page.locator('.queue-pop .queue-row');
    await expect(rows).toHaveCount(DEBUT.tracks);

    // Shuffle; the queue length must be preserved and the bar keeps showing a track.
    await page.getByRole('button', { name: 'Shuffle' }).click();
    await expect(rows).toHaveCount(DEBUT.tracks);
    await expect(page.locator('.player .player-title')).not.toHaveText('');
  });

  test('seek bar advances the <audio> currentTime', async ({ page }) => {
    await gotoApp(page);
    await playDebut(page);

    // Pause first so currentTime doesn't drift under us while we assert.
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect.poll(() => audioPaused(page)).toBe(true);

    // The real WAV is ~2s; wait for the duration metadata so the seek range has a usable max.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = Array.from(document.querySelectorAll('audio')).find((e) => (e as HTMLAudioElement).src) as
            | HTMLAudioElement
            | undefined;
          return el && Number.isFinite(el.duration) ? el.duration : 0;
        }),
      )
      .toBeGreaterThan(0);

    const seek = page.locator('.player .player-seek input.seek');
    // Drive the range via the native value setter + an 'input' event so React's onChange (→ p.seek) fires;
    // Playwright's fill() is unreliable on <input type=range>.
    await seek.evaluate((el) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // seek() sets the active element's currentTime.
    await expect.poll(() => audioCurrentTime(page)).toBeGreaterThan(0.5);
  });

  test('opening the now-playing card / album keeps a track loaded (player-np clickable)', async ({ page }) => {
    await gotoApp(page);
    await playDebut(page);
    // The now-playing block becomes a clickable "Open album" affordance once a track has an albumId.
    const np = page.locator('.player .player-np.clickable');
    await expect(np).toBeVisible();
    await expect(np).toHaveAttribute('title', 'Open album');
  });

  /* --------------------------------- AudioSettings --------------------------------- */

  test('AudioSettings: EQ preset Bass persists somm.eq', async ({ page }) => {
    await gotoApp(page);
    await playDebut(page);

    await page.getByRole('button', { name: 'Audio settings' }).click();
    const pop = page.locator('.audio-pop');
    await expect(pop).toBeVisible();

    // EQ chips are real <button>s labelled by preset ("Bass").
    await pop.getByRole('button', { name: 'Bass', exact: true }).click();
    await expect(pop.getByRole('button', { name: 'Bass', exact: true })).toHaveClass(/\bon\b/);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('somm.eq')))
      .toBe('bass');
  });

  test('AudioSettings: Night/room mode toggle persists somm.night', async ({ page }) => {
    await gotoApp(page);
    await playDebut(page);

    await page.getByRole('button', { name: 'Audio settings' }).click();
    const pop = page.locator('.audio-pop');
    await expect(pop).toBeVisible();

    const night = pop.locator('.audio-toggle input[type="checkbox"]');
    await expect(night).not.toBeChecked();
    await night.check();
    await expect(night).toBeChecked();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('somm.night')))
      .toBe('1');

    await night.uncheck();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('somm.night')))
      .toBe('0');
  });

  test('AudioSettings: Crossfade seconds persists somm.xfade', async ({ page }) => {
    await gotoApp(page);
    await playDebut(page);

    await page.getByRole('button', { name: 'Audio settings' }).click();
    const pop = page.locator('.audio-pop');
    await expect(pop).toBeVisible();

    // Crossfade section chips read "Off", "2s", "4s", "8s". Pick 4s → somm.xfade === '4'.
    // Scope to the Crossfade section so we don't accidentally match an EQ chip.
    const crossfade = page.locator('.audio-sec', { hasText: 'Crossfade' });
    await crossfade.getByRole('button', { name: '4s', exact: true }).click();
    await expect(crossfade.getByRole('button', { name: '4s', exact: true })).toHaveClass(/\bon\b/);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('somm.xfade')))
      .toBe('4');
  });

  test('AudioSettings popover closes with the ✕ button', async ({ page }) => {
    await gotoApp(page);
    await playDebut(page);

    await page.getByRole('button', { name: 'Audio settings' }).click();
    const pop = page.locator('.audio-pop');
    await expect(pop).toBeVisible();
    await pop.getByRole('button', { name: 'Close' }).click();
    await expect(pop).toBeHidden();
  });

  /* ------------------------------------ Lyrics ------------------------------------- */

  test('Lyrics: synced lines render from the lyrics endpoint, then close', async ({ page }) => {
    await gotoApp(page);
    // Mock BEFORE anything triggers a lyrics fetch so it never touches the network.
    await page.route('**/api/lyrics*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          source: 'lrclib',
          synced: [
            { time: 0, text: 'Line one' },
            { time: 1, text: 'Line two' },
          ],
          plain: 'Line one\nLine two',
        }),
      }),
    );

    await playDebut(page);
    await page.getByRole('button', { name: 'Lyrics', exact: true }).click();

    const overlay = page.locator('.lyrics-overlay');
    await expect(overlay).toBeVisible();
    // Both synced lines render.
    await expect(overlay.locator('.lyrics-line')).toHaveCount(2);
    await expect(overlay.getByText('Line one', { exact: true })).toBeVisible();
    await expect(overlay.getByText('Line two', { exact: true })).toBeVisible();
    // Source label reflects the lrclib origin.
    await expect(overlay.locator('.lyrics-src')).toHaveText('lrclib.net');

    // Close via the ✕ close button.
    await overlay.getByRole('button', { name: 'Close lyrics' }).click();
    await expect(overlay).toBeHidden();
  });

  test('Lyrics: empty result shows the "No lyrics found" message', async ({ page }) => {
    await gotoApp(page);
    await page.route('**/api/lyrics*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, source: null, synced: null, plain: null }),
      }),
    );

    await playDebut(page);
    await page.getByRole('button', { name: 'Lyrics', exact: true }).click();

    const overlay = page.locator('.lyrics-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.lyrics-empty')).toBeVisible();
    await expect(overlay.locator('.lyrics-empty')).toContainText('No lyrics found');
    // No synced lines rendered.
    await expect(overlay.locator('.lyrics-line')).toHaveCount(0);
  });
});
