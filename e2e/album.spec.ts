import { test, expect, type Page } from '@playwright/test';
import { SEED, gotoApp, openTab, deleteAllPlaylists } from './helpers';

/**
 * Album detail page (AlbumPage in web/src/Library.tsx). Navigate: Library → Albums sub-tab → the "Debut"
 * album card. Debut (al-debut) has 3 tracks: Wanderer / Signal Fire / Cover Song, year 2001, confidence 0.72.
 *
 * Network-touching endpoints (MusicBrainz / Cover Art Archive) are intercepted with page.route and given
 * canned JSON so these tests are deterministic and never touch the network. Everything else runs against
 * the seeded SQLite catalog for real.
 */

const DEBUT = SEED.albums.debut; // { title:'Debut', artist:'The Testers', year:2001, tracks:3 }
const TRACKS = ['Wanderer', 'Signal Fire', 'Cover Song'] as const;

/** Open Library → Albums → the Debut album card and wait for the detail header. */
async function openDebut(page: Page): Promise<void> {
  await openTab(page, 'Library');
  // Albums sub-tab is a real <button> in .lib-tabs.
  await page.getByRole('button', { name: 'Albums', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Albums');
  // Album cards are clickable <div>s (.album-card) — target by the visible album name.
  await page.locator('.album-card', { hasText: DEBUT.title }).click();
  // Detail header renders the album title as the <h1> inside .album-head.
  await expect(page.locator('.album-head h1')).toHaveText(DEBUT.title);
}

/** Whether the underlying <audio> is actually playing (has a src and is not paused). */
async function anyAudioPlaying(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('audio')).some((a) => !!a.currentSrc && !a.paused),
  );
}

test.describe('Album detail page', () => {
  test('header shows title, artist link, facts and evidence', async ({ page }) => {
    await gotoApp(page);
    await openDebut(page);

    const head = page.locator('.album-head');
    await expect(head.locator('h1')).toHaveText(DEBUT.title);

    // "by <artist>" link.
    const by = head.locator('.by');
    await expect(by).toContainText('by');
    await expect(by.locator('.link')).toHaveText(DEBUT.artist);

    // Facts: year · N tracks · size MB · confidence%.
    const facts = head.locator('.facts');
    await expect(facts).toContainText(String(DEBUT.year));
    await expect(facts).toContainText(`${DEBUT.tracks} tracks`);
    await expect(facts).toContainText('MB');
    await expect(facts).toContainText('% confidence');

    // Evidence "why grouped" list is present with at least one entry.
    await expect(head.locator('ul.evidence li').first()).toBeVisible();
  });

  test('track list shows the three grouped tracks in order', async ({ page }) => {
    await gotoApp(page);
    await openDebut(page);

    const rows = page.locator('.tracks .trk');
    await expect(rows).toHaveCount(DEBUT.tracks);
    for (let i = 0; i < TRACKS.length; i++) {
      await expect(rows.nth(i).locator('.tt')).toHaveText(TRACKS[i]!);
    }
  });

  test('Play album starts playback: first row active with eq, PlayerBar shows the title', async ({ page }) => {
    await gotoApp(page);
    await openDebut(page);

    await page.getByRole('button', { name: 'Play album' }).click();

    // First track row becomes active and shows the equalizer indicator.
    const firstRow = page.locator('.tracks .trk').first();
    await expect(firstRow).toHaveClass(/active/);
    await expect(firstRow.locator('.eq')).toBeVisible();

    // PlayerBar renders the now-playing track title.
    await expect(page.locator('.player .player-title')).toHaveText(TRACKS[0]);
    // And the equalizer is animating (playing) → .eq gets 'on'.
    await expect(firstRow.locator('.eq')).toHaveClass(/on/);

    // Real audio is decoding/playing in headless Chromium.
    await expect.poll(() => anyAudioPlaying(page)).toBe(true);
  });

  test('clicking a non-active track row plays it; clicking the active row again pauses', async ({ page }) => {
    await gotoApp(page);
    await openDebut(page);

    const rows = page.locator('.tracks .trk');
    const second = rows.nth(1); // "Signal Fire"
    await expect(second.locator('.tt')).toHaveText(TRACKS[1]);

    // Click a specific non-active row (a DIV) → it becomes active and the PlayerBar reflects it.
    await second.click();
    await expect(second).toHaveClass(/active/);
    await expect(page.locator('.player .player-title')).toHaveText(TRACKS[1]);
    await expect(second.locator('.eq')).toHaveClass(/on/);
    await expect.poll(() => anyAudioPlaying(page)).toBe(true);

    // Clicking the active row again toggles pause: .eq loses 'on' and the <audio> reports paused.
    await second.click();
    await expect(second.locator('.eq')).not.toHaveClass(/on/);
    await expect.poll(() => anyAudioPlaying(page)).toBe(false);
  });

  test('breadcrumb Library crumb navigates back to the artists list', async ({ page }) => {
    await gotoApp(page);
    await openDebut(page);

    // Breadcrumb crumbs are clickable <span class="crumb">.
    await page.locator('.breadcrumb .crumb', { hasText: 'Library' }).click();
    // Back on the Artists browse view: the Artists sub-tab is active and seeded artists show.
    await expect(page.getByText(SEED.artists.testers.name)).toBeVisible();
    await expect(page.locator('.list-count')).toContainText(String(SEED.counts.artists));
  });

  test('the "by <artist>" link navigates to the artist page', async ({ page }) => {
    await gotoApp(page);
    await openDebut(page);

    await page.locator('.album-head .by .link').click();
    // Artist page heading is the artist name.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(DEBUT.artist);
    // Breadcrumb now points at the artist.
    await expect(page.locator('.breadcrumb .here')).toHaveText(DEBUT.artist);
  });

  test.describe('per-track add-to-playlist', () => {
    test.beforeEach(async ({ page }) => {
      await gotoApp(page);
      await deleteAllPlaylists(page);
    });
    test.afterEach(async ({ page }) => {
      await deleteAllPlaylists(page);
    });

    test('compact "+" opens the menu without starting the row playing (stopPropagation)', async ({ page }) => {
      await openDebut(page);

      const rows = page.locator('.tracks .trk');
      const first = rows.first();
      // The compact add-to-playlist control is a <button title="Add to playlist"> rendering "＋".
      await first.getByTitle('Add to playlist').click();

      // A menu appears (empty state, since we cleared playlists).
      const menu = first.locator('.atp-menu');
      await expect(menu).toBeVisible();
      await expect(menu).toContainText('No playlists yet');

      // Clicking the "+" must NOT start playback of that row (stopPropagation on the button).
      await expect(first).not.toHaveClass(/active/);
      await expect.poll(() => anyAudioPlaying(page)).toBe(false);
      // No PlayerBar appears because nothing was played.
      await expect(page.locator('.player .player-title')).toHaveCount(0);
    });
  });
});

test.describe('Album refresh (MusicBrainz) panel', () => {
  test('Refresh shows the MusicBrainz match with a year-change checkbox and Apply', async ({ page }) => {
    // Mock the MB search + the pending cover fetch + apply/cancel so nothing hits the network.
    await page.route('**/api/album/refresh', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          matched: true,
          before: { title: DEBUT.title, year: DEBUT.year },
          match: { mbid: 'x', artist: DEBUT.artist, album: DEBUT.title, year: 2002, score: 0.9 },
          coverFetched: true,
        }),
      }),
    );
    await page.route('**/api/album/refresh/apply', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
    );
    await page.route('**/api/album/refresh/cancel', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
    );
    // The pending cover image would otherwise hit Cover Art Archive — fulfil a tiny image.
    await page.route('**/api/album/refresh/cover*', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from([]) }),
    );

    await gotoApp(page);
    await openDebut(page);

    await page.getByRole('button', { name: '⟲ Refresh' }).click();

    const panel = page.locator('.refresh-panel');
    await expect(panel).toBeVisible();
    // Match header shows the score and artist.
    await expect(panel.locator('.refresh-title')).toContainText('MusicBrainz match');
    await expect(panel.locator('.badge.good')).toHaveText('90%');

    // Year changes 2001 → 2002, so a year-change checkbox (checked) is offered.
    const yearField = panel.locator('.refresh-field', { hasText: 'Year' });
    await expect(yearField).toBeVisible();
    await expect(yearField.locator('input[type="checkbox"]')).toBeChecked();
    await expect(yearField).toContainText(String(DEBUT.year));
    await expect(yearField).toContainText('2002');

    // Apply is enabled (there is a change to apply).
    const apply = panel.getByRole('button', { name: 'Apply' });
    await expect(apply).toBeEnabled();
    await apply.click();
    // After applying, the panel closes.
    await expect(panel).toHaveCount(0);
  });
});

test.describe('Album completeness panel', () => {
  test('Completeness shows "Missing 2 of 5" with the missing tracklist', async ({ page }) => {
    await page.route('**/api/album/completeness', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          matched: true,
          mbAlbum: DEBUT.title,
          expected: 5,
          have: 3,
          missing: [
            { disc: 1, position: 4, title: 'Bonus A' },
            { disc: 1, position: 5, title: 'Bonus B' },
          ],
          extra: [],
        }),
      }),
    );

    await gotoApp(page);
    await openDebut(page);

    await page.getByRole('button', { name: '✓ Completeness' }).click();

    const panel = page.locator('.refresh-panel');
    await expect(panel).toBeVisible();
    // Header: "Missing 2 of 5 tracks".
    await expect(panel.locator('.refresh-title')).toContainText('Missing');
    await expect(panel.locator('.refresh-title')).toContainText('2');
    await expect(panel.locator('.refresh-title')).toContainText('5');

    // The two missing tracks are listed.
    const missing = panel.locator('ul.cmpl-missing li');
    await expect(missing).toHaveCount(2);
    await expect(missing.nth(0)).toContainText('Bonus A');
    await expect(missing.nth(1)).toContainText('Bonus B');
  });

  test('completeness renders without crashing when the payload omits the missing array', async ({ page }) => {
    // FIXED DEFECT: CompletenessPanel used to force-unwrap data.missing! when have<expected, which threw
    // if a matched payload omitted the `missing` array. Library.tsx now falls back to `data.missing ?? []`.
    await page.route('**/api/album/completeness', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, matched: true, mbAlbum: DEBUT.title, have: 1, expected: 5 }),
      }),
    );

    await gotoApp(page);
    await openDebut(page);

    await page.getByRole('button', { name: '✓ Completeness' }).click();

    // The user expects the panel to open and report that tracks are missing (4 of 5), not a blank crash.
    const panel = page.locator('.refresh-panel');
    await expect(panel).toBeVisible({ timeout: 3000 });
    await expect(panel.locator('.refresh-title')).toContainText('Missing', { timeout: 3000 });
    // The app must not have thrown an unhandled render error (album head still present).
    await expect(page.locator('.album-head h1')).toHaveText(DEBUT.title);
  });
});
