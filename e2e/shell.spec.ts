import { test, expect } from '@playwright/test';
import { gotoApp, openTab, openPalette, currentTheme, type TabName } from './helpers';

/**
 * App shell: sidebar navigation, theme toggle + persistence, sidebar collapse/resize persistence,
 * API status pill, global ⌘K palette, and the now-playing card. Sources: web/src/Sidebar.tsx,
 * web/src/theme.ts, web/src/App.tsx.
 */
test.describe('app shell', () => {
  test('each sidebar tab routes to its page and gets the active class', async ({ page }) => {
    await gotoApp(page);

    // Library is the default landing tab (App.tsx: useState<Tab>('library')).
    const libBtn = page.getByRole('button', { name: 'Library', exact: true });
    await expect(libBtn).toHaveClass(/active/);

    const cases: Array<{ tab: TabName; heading: string | RegExp }> = [
      { tab: 'Playlists', heading: 'Playlists' },
      { tab: 'Organize', heading: /Organi[sz]e/ },
      { tab: 'Sync', heading: /Sync|Drives/ },
      { tab: 'Overview', heading: 'Library Overview' },
      { tab: 'Library', heading: 'Library' },
    ];

    for (const { tab, heading } of cases) {
      await openTab(page, tab);
      // The page-1 heading matches (openTab already asserts this, re-assert for clarity).
      await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(heading);
      // The clicked sidebar nav button carries the 'active' class...
      const btn = page.getByRole('button', { name: tab, exact: true });
      await expect(btn).toHaveClass(/active/);
      // ...and no other nav tab is simultaneously active.
      const otherTabs = (['Library', 'Playlists', 'Organize', 'Sync', 'Overview'] as const).filter(
        (t) => t !== tab,
      );
      for (const other of otherTabs) {
        await expect(page.getByRole('button', { name: other, exact: true })).not.toHaveClass(/active/);
      }
    }
  });

  test('default theme is dark and the toggle flips + persists to localStorage', async ({ page }) => {
    await gotoApp(page);

    // Config default is dark (theme.ts systemTheme() → 'dark' with no stored value / no light color scheme).
    await expect.poll(() => currentTheme(page)).toBe('dark');

    const toggle = page.getByRole('button', { name: 'Toggle light/dark theme' });
    await expect(toggle).toBeVisible();

    // Flip to light.
    await toggle.click();
    await expect.poll(() => currentTheme(page)).toBe('light');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('somm.theme')))
      .toBe('light');

    // Flip back to dark.
    await toggle.click();
    await expect.poll(() => currentTheme(page)).toBe('dark');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('somm.theme')))
      .toBe('dark');
  });

  test('theme choice survives a reload', async ({ page }) => {
    await gotoApp(page);
    const toggle = page.getByRole('button', { name: 'Toggle light/dark theme' });

    // Choose light explicitly, then reload.
    await toggle.click();
    await expect.poll(() => currentTheme(page)).toBe('light');

    await page.reload();
    await expect(page.getByText('Media Sommelier', { exact: true })).toBeVisible();
    // The inline index.html script + theme.ts should re-apply the stored choice.
    await expect.poll(() => currentTheme(page)).toBe('light');

    // Restore dark so we leave the shared browser context in the config default.
    await page.getByRole('button', { name: 'Toggle light/dark theme' }).click();
    await expect.poll(() => currentTheme(page)).toBe('dark');
  });

  test('collapse button toggles the .sidebar.collapsed class and persists the flag', async ({ page }) => {
    await gotoApp(page);
    const sidebar = page.locator('.sidebar');
    await expect(sidebar).not.toHaveClass(/collapsed/);

    // Collapse: aria-label reads "Collapse sidebar" when expanded.
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(sidebar).toHaveClass(/collapsed/);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('somm.nav.collapsed')))
      .toBe('1');

    // Expand: after collapsing the same button's aria-label becomes "Expand sidebar".
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(sidebar).not.toHaveClass(/collapsed/);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('somm.nav.collapsed')))
      .toBe('0');
  });

  test('collapsed state survives a reload', async ({ page }) => {
    await gotoApp(page);
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.locator('.sidebar')).toHaveClass(/collapsed/);

    await page.reload();
    // When collapsed the brand *text* ("Media Sommelier") is not rendered, only the brand mark — so wait
    // on the mark to know the shell has re-mounted, then assert the persisted collapsed state.
    await expect(page.locator('.sidebar .brand-mark')).toBeVisible();
    // Sidebar initialises collapsed from localStorage 'somm.nav.collapsed' === '1'.
    await expect(page.locator('.sidebar')).toHaveClass(/collapsed/);

    // Restore expanded state for the shared context.
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(page.locator('.sidebar')).not.toHaveClass(/collapsed/);
  });

  test('drag on the resize handle persists somm.nav.width', async ({ page }) => {
    await gotoApp(page);
    const handle = page.locator('.sidebar-resize');
    await expect(handle).toBeVisible();

    // Drag the handle to a target x within [WIDTH_MIN=200, WIDTH_MAX=360]; the mouseup persists clientX.
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(300, box!.y + box!.height / 2, { steps: 8 });
    await page.mouse.up();

    // On release Sidebar writes the clamped, rounded width to localStorage.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('somm.nav.width')))
      .toBe('300');
  });

  test('the API status pill shows "API connected"', async ({ page }) => {
    await gotoApp(page);
    const pill = page.locator('.sidebar-foot .pill');
    await expect(pill).toContainText('API connected');
    // The status dot carries the 'ok' modifier when the health check succeeded.
    await expect(pill.locator('.dot')).toHaveClass(/ok/);
  });

  test('global Ctrl+K opens the command palette from a non-Library tab', async ({ page }) => {
    await gotoApp(page);
    // Navigate away from the default tab first to prove the shortcut is global.
    await openTab(page, 'Overview');
    await openPalette(page);
    await expect(page.locator('.cp-backdrop')).toBeVisible();
  });

  test('the now-playing card appears in the sidebar after playback starts', async ({ page }) => {
    await gotoApp(page);

    // Land on an album's track list so a real Play button is available. Debut is the seeded album
    // with a cover; open it via the seeded artist → album drill-down.
    await page.getByText('The Testers', { exact: true }).click();
    await expect(page.getByText('Debut', { exact: true })).toBeVisible();
    await page.getByText('Debut', { exact: true }).click();

    // Start playback via the album page's "Play album" button. (Note: /^Play/ would also match the
    // "Playlists" sidebar nav button, which sorts first in the DOM — so name it exactly.)
    const playBtn = page.getByRole('button', { name: 'Play album' });
    await expect(playBtn).toBeVisible();
    await playBtn.click();

    // The now-playing card renders in the sidebar once player.current is set.
    const npCard = page.locator('.np-card');
    await expect(npCard).toBeVisible();
    // It shows the seeded first track of Debut ("Wanderer") as the now-playing title.
    await expect(npCard.locator('.np-title')).toHaveText('Wanderer');
    // The equaliser bars get the 'on' modifier while audio is actually playing.
    await expect(npCard.locator('.eq')).toHaveClass(/on/);
  });
});
