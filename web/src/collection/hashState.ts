// Low-level URL-hash helpers so view state can be shared via a link — without adding a router. App.tsx maps
// the flat record ↔ its tab + LibraryView; useViewPrefs contributes/reads the `sort/dir/layout/…/f.<facet>`
// keys. Everything goes through history.replaceState so navigation history isn't polluted.

/** Parse the current (or a given) location.hash into a flat record. */
export function parseHash(hash: string = typeof location !== 'undefined' ? location.hash : ''): Record<string, string> {
  const sp = new URLSearchParams(hash.replace(/^#/, ''));
  const out: Record<string, string> = {};
  for (const [k, v] of sp.entries()) out[k] = v;
  return out;
}

/** Serialize a record to a hash string ('' → no hash), dropping empty values. */
export function buildHash(record: Record<string, string | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(record)) if (v != null && v !== '') sp.set(k, v);
  const s = sp.toString();
  return s ? '#' + s : '';
}

/** Replace the hash in place (no new history entry). Guarded so callers can detect programmatic writes. */
export function replaceHash(record: Record<string, string | undefined | null>): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const hash = buildHash(record);
  const base = location.pathname + location.search;
  history.replaceState(null, '', hash ? base + hash : base);
}
