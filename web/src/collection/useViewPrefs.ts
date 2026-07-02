// Per-view preferences (sort/dir/layout/density/coverSize/filters), persisted to localStorage under
// `somm.view.<key>` — the same try/catch convention as web/src/theme.ts and player.tsx. `q` (search) is
// deliberately NOT persisted, so a stale query never reappears on reload.
import { useCallback, useState } from 'react';
import type { ViewPrefs } from './types';

const PREFIX = 'somm.view.';

function read(key: string, defaults: ViewPrefs): ViewPrefs {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<ViewPrefs>;
    return {
      ...defaults,
      ...parsed,
      q: defaults.q, // never restored from storage
      filters: { enums: { ...(parsed.filters?.enums ?? {}) } },
    };
  } catch {
    return defaults;
  }
}

function persist(key: string, prefs: ViewPrefs): void {
  try {
    // everything but q
    const toStore = {
      sort: prefs.sort,
      dir: prefs.dir,
      layout: prefs.layout,
      density: prefs.density,
      coverSize: prefs.coverSize,
      filters: prefs.filters,
    };
    localStorage.setItem(PREFIX + key, JSON.stringify(toStore));
  } catch {
    /* private mode / quota — non-fatal */
  }
}

export interface ViewPrefsApi {
  prefs: ViewPrefs;
  update: (patch: Partial<ViewPrefs>) => void;
  set: <K extends keyof ViewPrefs>(k: K, v: ViewPrefs[K]) => void;
  setFilter: (facetKey: string, values: string[]) => void;
  toggleFilterValue: (facetKey: string, value: string) => void;
  clearFilters: () => void;
  reset: () => void;
}

export function useViewPrefs(key: string, defaults: ViewPrefs): ViewPrefsApi {
  const [prefs, setPrefs] = useState<ViewPrefs>(() => read(key, defaults));

  const commit = useCallback(
    (next: ViewPrefs) => {
      persist(key, next);
      setPrefs(next);
    },
    [key],
  );

  const update = useCallback(
    (patch: Partial<ViewPrefs>) => setPrefs((p) => {
      const next = { ...p, ...patch };
      persist(key, next);
      return next;
    }),
    [key],
  );

  const set = useCallback(
    <K extends keyof ViewPrefs>(k: K, v: ViewPrefs[K]) => update({ [k]: v } as unknown as Partial<ViewPrefs>),
    [update],
  );

  const setFilter = useCallback(
    (facetKey: string, values: string[]) =>
      setPrefs((p) => {
        const enums = { ...p.filters.enums };
        if (values.length === 0) delete enums[facetKey];
        else enums[facetKey] = values;
        const next = { ...p, filters: { enums } };
        persist(key, next);
        return next;
      }),
    [key],
  );

  const toggleFilterValue = useCallback(
    (facetKey: string, value: string) =>
      setPrefs((p) => {
        const cur = p.filters.enums[facetKey] ?? [];
        const nextVals = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
        const enums = { ...p.filters.enums };
        if (nextVals.length === 0) delete enums[facetKey];
        else enums[facetKey] = nextVals;
        const next = { ...p, filters: { enums } };
        persist(key, next);
        return next;
      }),
    [key],
  );

  const clearFilters = useCallback(() => update({ filters: { enums: {} } }), [update]);

  const reset = useCallback(() => commit({ ...defaults, q: '' }), [commit, defaults]);

  return { prefs, update, set, setFilter, toggleFilterValue, clearFilters, reset };
}
