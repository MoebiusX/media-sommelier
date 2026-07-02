import { test, expect, type Page } from '@playwright/test';
import { SEED, gotoApp, openTab } from './helpers';

/**
 * Organize tab coverage — the folder organizer (Organize.tsx) and the metadata reconstruction / reorganize
 * panels (MetadataSim.tsx).
 *
 * Determinism: every endpoint that would spawn a copy child-process or hit an external service is mocked
 * with page.route BEFORE the action, so NO real files are ever copied. The read-only metadata reconstruction
 * (GET /api/reconstruct/metadata) is the one thing we let run for real against the seeded DB — the seeded
 * "Signals" album spans two disc folders, so it is an integrated album we can assert on.
 */

const SOURCE = 'C:\\fake\\messy-music'; // any non-empty string enables Simulate/Preview/Organize buttons.

/** Fill the Organize page's own "Source" input so source-gated buttons enable. */
async function setSource(page: Page, value: string): Promise<void> {
  const input = page.locator('input.sb-input').first();
  await input.fill(value);
  await expect(input).toHaveValue(value);
}

/** Canned SimulateResult with a clearly-recommended scheme (big sparse spread → "meaningful" verdict). */
function simulatePayload() {
  const hist = [
    { label: '1', folders: 3 },
    { label: '2', folders: 2 },
    { label: '3-5', folders: 4 },
    { label: '6+', folders: 1 },
  ];
  return {
    source: SOURCE,
    recommended: 'artist-year-album',
    schemes: [
      {
        key: 'artist-year-album',
        label: 'Artist / Year — Album',
        template: '{artist}/{year} - {album}',
        folders: 120,
        tracks: 500,
        singletonFolders: 3,
        sparseFolders: 5,
        sparseTracks: 8,
        medianPerFolder: 6,
        largestFolder: 20,
        collisions: 0,
        skipped: 0,
        hist,
      },
      {
        key: 'artist-album',
        label: 'Artist / Album',
        template: '{artist}/{album}',
        folders: 130,
        tracks: 500,
        singletonFolders: 40,
        sparseFolders: 60,
        sparseTracks: 90,
        medianPerFolder: 4,
        largestFolder: 20,
        collisions: 2,
        skipped: 0,
        hist,
      },
      {
        key: 'flat',
        label: 'Flat',
        template: '{title}',
        folders: 1,
        tracks: 500,
        singletonFolders: 0,
        sparseFolders: 0,
        sparseTracks: 0,
        medianPerFolder: 500,
        largestFolder: 500,
        collisions: 0,
        skipped: 0,
        hist: [{ label: '6+', folders: 1 }],
      },
    ],
  };
}

/** Canned PlanSummary for the folder-organize dry run. */
function planPayload() {
  return {
    actions: 500,
    collisions: 2,
    skipped: 7,
    sample: [
      'The Testers/2001 - Debut/01 Wanderer.wav',
      'Ada Lovelace/2018 - Signals/01 Intro.wav',
      'Blue Quartet/1999 - Midnight/01 Blue in Green.wav',
    ],
  };
}

/** A finished organize job — the run() poller stops on state 'done' and renders this summary. */
function doneStatus(dest: string) {
  return {
    state: 'done',
    dest,
    phase: 'done',
    done: 16,
    total: 16,
    result: { copied: 16, skipped: 0, failed: 0, tagged: 16, bytes: 123_456_789, dest },
  };
}

test.describe('Organize — folder organizer', () => {
  test('renders the organizer form with source/dest/scheme controls and actions', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Organize');

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Organize a music library');
    // Scheme preset <select> is populated from GET /api/presets (runs for real).
    const scheme = page.locator('select.sb-input');
    await expect(scheme).toBeVisible();
    await expect(scheme.locator('option')).not.toHaveCount(0);
    // The three primary actions are real <button>s.
    await expect(page.getByRole('button', { name: 'Simulate schemes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preview plan' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Organize → copy' })).toBeVisible();
  });

  test('Simulate schemes / Preview plan / Organize stay disabled until a source is set', async ({ page }) => {
    await gotoApp(page);
    await openTab(page, 'Organize');

    // App starts with an empty shared source in the seeded harness → source-gated buttons are disabled.
    await expect(page.getByRole('button', { name: 'Simulate schemes' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Organize → copy' })).toBeDisabled();

    await setSource(page, SOURCE);
    await expect(page.getByRole('button', { name: 'Simulate schemes' })).toBeEnabled();
  });

  test('Simulate schemes shows the comparison table and marks the recommended scheme', async ({ page }) => {
    await page.route('**/api/organize/simulate', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(simulatePayload()) }),
    );

    await gotoApp(page);
    await openTab(page, 'Organize');
    await setSource(page, SOURCE);

    await page.getByRole('button', { name: 'Simulate schemes' }).click();

    // The comparison panel appears with one column per scheme.
    await expect(page.getByText('Naming scheme comparison')).toBeVisible();
    const cols = page.locator('.scheme-col');
    await expect(cols).toHaveCount(3);
    // The recommended scheme gets the "fewest sparse" badge and a highlighted column.
    await expect(page.locator('.scheme-col.best')).toHaveCount(1);
    await expect(page.locator('.badge.good', { hasText: 'fewest sparse' })).toBeVisible();
    // The meaningful-winner verdict names the recommended scheme label.
    await expect(page.locator('.scheme-verdict')).toContainText('Artist / Year — Album');
  });

  test('Preview plan shows action/collision/skip counts and a sample path tree', async ({ page }) => {
    await page.route('**/api/organize/plan', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(planPayload()) }),
    );

    await gotoApp(page);
    await openTab(page, 'Organize');
    await setSource(page, SOURCE);

    await page.getByRole('button', { name: 'Preview plan' }).first().click();

    await expect(page.getByText('Plan preview')).toBeVisible();
    const facts = page.locator('.panel', { hasText: 'Plan preview' }).locator('.facts').first();
    await expect(facts).toContainText('500 files to copy');
    await expect(facts).toContainText('2 collisions');
    await expect(facts).toContainText('7 skipped');
    // Sample paths render in the <pre class="tree"> block.
    const tree = page.locator('.panel', { hasText: 'Plan preview' }).locator('pre.tree');
    await expect(tree).toContainText('The Testers/2001 - Debut/01 Wanderer.wav');
    await expect(tree).toContainText('and 497 more');
  });

  test('Organize → copy shows a done summary after the job completes (no real copy)', async ({ page }) => {
    const dest = 'C:\\fake\\Organized';
    // Mock the run kickoff and the status poll → job finishes immediately as "done".
    await page.route('**/api/organize/run', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
    );
    await page.route('**/api/organize/status', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doneStatus(dest)) }),
    );

    await gotoApp(page);
    await openTab(page, 'Organize');
    await setSource(page, SOURCE);

    await page.getByRole('button', { name: 'Organize → copy' }).click();

    // Done summary: the ok-text headline + the facts row with copied/skipped/failed/tagged.
    await expect(page.getByText(/Organized 16 files into/)).toBeVisible();
    const facts = page.locator('.panel .facts', { hasText: 'copied' }).first();
    await expect(facts).toContainText('16 copied');
    await expect(facts).toContainText('0 skipped');
    await expect(facts).toContainText('0 failed');
    await expect(facts).toContainText('16 tagged');
    await expect(page.getByRole('button', { name: /Browse the organized library/ })).toBeVisible();
  });
});

test.describe('Organize — reconstruct by metadata', () => {
  test('Simulate metadata grouping surfaces the seeded integrated album (Signals)', async ({ page }) => {
    // Runs for REAL against the seeded DB (no mock). Seed "Signals" spans Disc 1 + Disc 2 folders → integrated.
    await gotoApp(page);
    await openTab(page, 'Organize');

    await page.getByRole('button', { name: 'Simulate metadata grouping' }).click();

    // Verdict line reports at least one integrated album; the chips panel shows the counts.
    const verdict = page.locator('.panel', { hasText: 'Reconstruct by metadata' }).locator('.scheme-verdict');
    await expect(verdict).toContainText(/Metadata grouping finds \d+ albums/);
    await expect(verdict).toContainText(/\d+ of them integrate/);

    // The seeded catalog has exactly one integrated (multi-folder) album, "Signals" by Ada Lovelace.
    await expect(page.getByText(SEED.albums.signals.title, { exact: true })).toBeVisible();
    const card = page.locator('.meta-album', { hasText: SEED.albums.signals.title });
    await expect(card).toContainText(SEED.albums.signals.artist);
    await expect(card).toContainText(`${SEED.albums.signals.tracks} tracks`);
    // Signals is a 2-disc album pulled from 2 folders.
    await expect(card).toContainText(`${SEED.albums.signals.discs} discs`);
    await expect(card).toContainText('from 2 folders');
  });

  test('Reorganize by metadata: Preview plan renders the tag-based plan summary', async ({ page }) => {
    await page.route('**/api/organize/metadata/plan', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(planPayload()) }),
    );

    await gotoApp(page);
    await openTab(page, 'Organize');

    // The "Reorganize by metadata" panel's Preview plan button (it needs only a dest, prefilled by default).
    const panel = page.locator('.panel', { hasText: 'Reorganize by metadata' });
    await panel.getByRole('button', { name: 'Preview plan' }).click();

    await expect(panel.locator('.facts')).toContainText('500 files to copy');
    await expect(panel.locator('.facts')).toContainText('2 collisions');
    await expect(panel.locator('.facts')).toContainText('7 skipped');
    await expect(panel.locator('pre.tree')).toContainText('Ada Lovelace/2018 - Signals/01 Intro.wav');
  });

  test('Reorganize by metadata: Organize into this folder shows a done summary (no real copy)', async ({ page }) => {
    const dest = 'C:\\fake\\Organized-by-tags';
    // startOrganizeMetadata posts to /api/organize/run with mode:'metadata' and expects { ok, job }.
    await page.route('**/api/organize/run', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, job: { state: 'running', phase: 'starting', done: 0, total: 16 } }),
      }),
    );
    // The MetadataSim poller reads /api/organize/status until state !== 'running'.
    await page.route('**/api/organize/status', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doneStatus(dest)) }),
    );

    await gotoApp(page);
    await openTab(page, 'Organize');

    const panel = page.locator('.panel', { hasText: 'Reorganize by metadata' });
    await panel.getByRole('button', { name: 'Organize into this folder' }).click();

    // The poll runs on a 1s interval; the done headline appears once status resolves to 'done'.
    await expect(panel.getByText(/Organized 16 files into/)).toBeVisible();
    await expect(panel.locator('code', { hasText: dest })).toBeVisible();
  });
});
