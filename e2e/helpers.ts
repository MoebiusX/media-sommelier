/**
 * Shared E2E helpers + a mirror of the seeded catalog (e2e/seed.ts). Specs import SEED to assert against
 * known data, and use the small navigation/reset helpers to stay isolated (the suite runs serially against
 * one shared backend, so mutating specs clean up after themselves).
 */
import { expect, type Page } from '@playwright/test';

/** The deterministic catalog created by e2e/seed.ts. Keep in sync with the ALBUMS array there. */
export const SEED = {
  counts: { tracks: 16, albums: 6, artists: 5 },
  artists: {
    testers: { name: 'The Testers', tracks: 5, albums: 2 },
    ada: { name: 'Ada Lovelace', tracks: 4, albums: 1 },
    blue: { name: 'Blue Quartet', tracks: 3, albums: 1 },
    various: { name: 'Various Artists', tracks: 3, albums: 1 },
    echo: { name: 'Echo Chamber', tracks: 1, albums: 1 },
  },
  albums: {
    debut: { id: 'al-debut', title: 'Debut', artist: 'The Testers', year: 2001, tracks: 3, hasCover: true },
    live: { id: 'al-live', title: 'Live Sessions', artist: 'The Testers', year: 2003, tracks: 2, flags: ['needs review', 'no track #s'] },
    signals: { id: 'al-signals', title: 'Signals', artist: 'Ada Lovelace', year: 2018, tracks: 4, discs: 2, integrated: true },
    midnight: { id: 'al-midnight', title: 'Midnight', artist: 'Blue Quartet', year: 1999, tracks: 3, lossless: true },
    roadtrip: { id: 'al-roadtrip', title: 'Road Trip Mix', artist: 'Various Artists', year: 2010, tracks: 3, flags: ['compilation'] },
    drift: { id: 'al-drift', title: 'Drift', artist: 'Echo Chamber', year: 2020, tracks: 1, flags: ['orphan'] },
  },
  /** A track that appears twice (Debut lossless + Live lossy) → the one duplicate group. */
  duplicateTitle: 'Wanderer',
  genres: ['Rock', 'Electronic', 'Jazz', 'Pop', 'Ambient'],
} as const;

/** Sidebar tab labels (accessible button names). */
export type TabName = 'Library' | 'Playlists' | 'Organize' | 'Sync' | 'Overview';

/** Load the app and wait until the shell is interactive (sidebar + API connected). */
export async function gotoApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByText('Media Sommelier', { exact: true })).toBeVisible();
  // The API-status pill flips to "API connected" once GET /api/health resolves.
  await expect(page.locator('.sidebar-foot .pill')).toContainText('API connected');
}

/** Click a top-level sidebar tab and wait for its page heading. */
export async function openTab(page: Page, tab: TabName): Promise<void> {
  await page.getByRole('button', { name: tab, exact: true }).click();
  const heading: Record<TabName, string | RegExp> = {
    Library: 'Library',
    Playlists: 'Playlists',
    Organize: /Organi[sz]e/,
    Sync: /Sync|Drives/,
    Overview: 'Library Overview',
  };
  await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(heading[tab]);
}

/** Open the ⌘K command palette (Ctrl+K works cross-platform in Chromium here). */
export async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  await expect(page.locator('.cp-backdrop')).toBeVisible();
}

/* --------------------------- state reset (mutating specs) --------------------------- */

/** Delete every playlist via the API so a spec starts from a known-empty state. */
export async function deleteAllPlaylists(page: Page): Promise<void> {
  const res = await page.request.get('/api/playlists');
  const rows = (await res.json()) as Array<{ id: number }>;
  for (const r of rows) await page.request.post('/api/playlists/delete', { data: { id: r.id } });
}

/** Delete every sync profile via the API so a spec starts from a known-empty state. */
export async function deleteAllProfiles(page: Page): Promise<void> {
  const res = await page.request.get('/api/profiles');
  const rows = (await res.json()) as Array<{ id: number }>;
  for (const r of rows) await page.request.post('/api/profiles/delete', { data: { id: r.id } });
}

/** Read the effective theme (data-theme on <html>). */
export async function currentTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}
