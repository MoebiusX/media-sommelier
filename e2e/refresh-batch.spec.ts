import { test, expect } from '@playwright/test';
import { SEED, gotoApp, openTab } from './helpers';

/**
 * RefreshBatch panel ("Cover art & metadata") inside the Overview tab.
 *
 * ALL of this component's endpoints hit MusicBrainz / Cover Art Archive, so every test mocks them with
 * page.route set up BEFORE gotoApp — the suite must never touch the network or the filesystem. Everything
 * else (the seeded catalog) runs for real. These tests do not create durable server state (apply-batch is
 * mocked), so no reset helpers are needed.
 */

const CAND = '**/api/refresh/candidates';
const START = '**/api/refresh/start';
const STATUS = '**/api/refresh/status';
const APPLY_BATCH = '**/api/refresh/apply-batch';
const PENDING_COVER = '**/api/album/refresh/cover*';

/** 1×1 transparent PNG — matches the seed's tiny cover, so the <img> in a proposal row loads. */
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** The seeded "Live Sessions" album is the proposal the mocked sweep surfaces. */
const LIVE = SEED.albums.live; // { id: 'al-live', title: 'Live Sessions', artist: 'The Testers', year: 2003 }

/** A DONE job carrying exactly one proposal: a fetched cover + a year change 2003 → 2004. */
const doneJob = {
  state: 'done',
  phase: 'done',
  done: 3,
  total: 3,
  proposals: [
    {
      albumId: LIVE.id,
      artistName: LIVE.artist,
      title: LIVE.title,
      year: LIVE.year, // 2003
      match: { album: LIVE.title, year: 2004, score: 0.88, mbid: 'm1' },
      coverFetched: true,
    },
  ],
};

const runningJob = { ok: true, job: { state: 'running', phase: '', done: 0, total: 3, proposals: [] } };

/** Wire up all external endpoints with deterministic responses. Call BEFORE gotoApp. */
async function mockRefresh(
  page: import('@playwright/test').Page,
  opts: {
    candidates?: unknown;
    candidatesAbort?: boolean;
    status?: unknown;
  } = {},
): Promise<void> {
  await page.route(CAND, async (route) => {
    if (opts.candidatesAbort) return route.abort('failed');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(opts.candidates ?? { missing: 3, attempted: 0, total: 6 }),
    });
  });
  await page.route(START, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(runningJob) }),
  );
  await page.route(STATUS, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(opts.status ?? doneJob),
    }),
  );
  await page.route(APPLY_BATCH, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, applied: 1 }) }),
  );
  await page.route(PENDING_COVER, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PX_PNG }),
  );
}

/** Scope to the RefreshBatch panel (its title text is unique on the Overview page). */
function panel(page: import('@playwright/test').Page) {
  return page.locator('.panel', { hasText: 'Cover art & metadata' });
}

test.describe('Overview · Cover art & metadata refresh', () => {
  test('intro shows the missing-cover count and an enabled "Find missing covers" button', async ({ page }) => {
    await mockRefresh(page);
    await gotoApp(page);
    await openTab(page, 'Overview');

    const rb = panel(page);
    await expect(rb).toBeVisible();
    // "<b>3</b> of 6 albums have no cover art" — attempted=0 so no "already checked" suffix.
    await expect(rb.locator('.rb-intro')).toContainText('3 of 6 albums have no cover art');

    const findBtn = rb.getByRole('button', { name: 'Find missing covers' });
    await expect(findBtn).toBeVisible();
    await expect(findBtn).toBeEnabled();
  });

  test('clicking "Find missing covers" runs the sweep and transitions to the review queue', async ({ page }) => {
    await mockRefresh(page);
    await gotoApp(page);
    await openTab(page, 'Overview');

    const rb = panel(page);
    await rb.getByRole('button', { name: 'Find missing covers' }).click();

    // After the ~1.2s poll debounce the job is done → the review head appears. Auto-waiting covers the wait.
    await expect(rb.locator('.rb-review-head')).toBeVisible();
    await expect(rb.locator('.rb-review-head')).toContainText('1 proposals');

    // The single proposal row shows the seeded album title, the "cover" badge, and the 2003→2004 year change.
    const row = rb.locator('.rb-row');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.rb-title')).toHaveText(LIVE.title);
    await expect(row.locator('.badge.good')).toHaveText('cover');
    await expect(row.locator('.badge.multi')).toContainText('2003→2004');
  });

  test('Select all / Deselect all toggles the Apply count between "Apply 1" and disabled', async ({ page }) => {
    await mockRefresh(page);
    await gotoApp(page);
    await openTab(page, 'Overview');

    const rb = panel(page);
    await rb.getByRole('button', { name: 'Find missing covers' }).click();
    await expect(rb.locator('.rb-review-head')).toBeVisible();

    // Proposals are pre-selected on completion, so Apply starts enabled at "Apply 1".
    const applyBtn = rb.getByRole('button', { name: /^Apply \d+$/ });
    await expect(applyBtn).toHaveText('Apply 1');
    await expect(applyBtn).toBeEnabled();

    // With everything selected the toggle reads "Deselect all"; clicking it clears the selection.
    await rb.getByRole('button', { name: 'Deselect all' }).click();
    await expect(applyBtn).toHaveText('Apply 0');
    await expect(applyBtn).toBeDisabled();

    // The toggle now reads "Select all"; clicking it re-selects the proposal.
    await rb.getByRole('button', { name: 'Select all' }).click();
    await expect(applyBtn).toHaveText('Apply 1');
    await expect(applyBtn).toBeEnabled();
  });

  test('clicking "Apply 1" applies the batch and returns to the intro with a confirmation', async ({ page }) => {
    await mockRefresh(page);
    await gotoApp(page);
    await openTab(page, 'Overview');

    const rb = panel(page);
    await rb.getByRole('button', { name: 'Find missing covers' }).click();
    await expect(rb.locator('.rb-review-head')).toBeVisible();

    const applyReq = page.waitForRequest(
      (r) => r.url().includes('/api/refresh/apply-batch') && r.method() === 'POST',
    );
    await rb.getByRole('button', { name: /^Apply \d+$/ }).click();
    await applyReq;

    // Back to the intro state with the success note.
    await expect(rb.locator('.ok-text')).toHaveText('✓ applied 1 just now.');
    await expect(rb.locator('.rb-review-head')).toHaveCount(0);
    await expect(rb.getByRole('button', { name: 'Find missing covers' })).toBeVisible();
  });

  test('an errored status job still surfaces an error affordance in review', async ({ page }) => {
    // FIXED DEFECT: a sweep ending state:'error' with proposals used to render the ordinary review queue
    // with no sign of the failure. RefreshBatch now shows "Sweep stopped early: {job.error}" above the queue.
    await mockRefresh(page, {
      status: {
        state: 'error',
        phase: 'error',
        error: 'boom',
        done: 1,
        total: 3,
        proposals: doneJob.proposals,
      },
    });
    await gotoApp(page);
    await openTab(page, 'Overview');

    const rb = panel(page);
    await rb.getByRole('button', { name: 'Find missing covers' }).click();

    // The review queue appears (error jobs with proposals are treated as "reviewing")…
    await expect(rb.locator('.rb-review-head')).toBeVisible();
    // …and the failure ("boom") should be communicated to the user somewhere in the panel.
    await expect(rb).toContainText('boom', { timeout: 3000 });
  });

  test('a failing candidates request does not leave the panel stuck on "Checking your library…"', async ({
    page,
  }) => {
    // FIXED DEFECT: RefreshBatch used to swallow a failed /api/refresh/candidates (empty catch), pinning
    // the intro on "Checking your library…" forever. It now shows an error + a "Retry" link.
    await mockRefresh(page, { candidatesAbort: true });
    await gotoApp(page);
    await openTab(page, 'Overview');

    const rb = panel(page);
    await expect(rb).toBeVisible();
    // A user should eventually see either the real state or an error — never an indefinite loading string.
    await expect(rb.locator('.rb-intro')).not.toContainText('Checking your library…', { timeout: 3000 });
  });
});
