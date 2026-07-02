// Pure, in-memory faceting + sorting for a fetched collection. No React, no fetching — trivially testable and
// exercised end-to-end by the collection Playwright specs. Facets are categorical (values may bucket a
// continuous field, e.g. year → "2000s"); semantics are OR-within-a-facet, AND-across-facets, with counts
// computed live over the other-facets-filtered set so they narrow as you filter.
import type { ActiveFilters, CollectionDescriptor, FacetDef, SortDef, SortDir, ViewPrefs } from './types';

/** Non-empty string values a facet reports for an item. */
export function facetValues<T>(def: FacetDef<T>, item: T): string[] {
  const raw = def.values(item);
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((v): v is string => v != null && v !== '');
}

/** True if the item passes every active facet (optionally ignoring one facet, for live count computation). */
export function matchesFilters<T>(
  item: T,
  defs: FacetDef<T>[],
  filters: ActiveFilters,
  exclude?: string,
): boolean {
  for (const def of defs) {
    if (def.key === exclude) continue;
    const sel = filters.enums[def.key];
    if (!sel || sel.length === 0) continue;
    const vals = facetValues(def, item);
    if (!vals.some((v) => sel.includes(v))) return false;
  }
  return true;
}

export function applyFilters<T>(items: T[], defs: FacetDef<T>[], filters: ActiveFilters, exclude?: string): T[] {
  const anyActive = defs.some((d) => d.key !== exclude && (filters.enums[d.key]?.length ?? 0) > 0);
  if (!anyActive) return items;
  return items.filter((it) => matchesFilters(it, defs, filters, exclude));
}

export function sortItems<T>(items: T[], sortDef: SortDef<T>, dir: SortDir): T[] {
  const mul = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const av = sortDef.sortValue(a);
    const bv = sortDef.sortValue(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls last, both directions
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
    return String(av).localeCompare(String(bv)) * mul;
  });
}

export interface FacetValueCount {
  value: string;
  count: number;
}
export interface ComputedFacet {
  key: string;
  label: string;
  values: FacetValueCount[];
}
export type ComputedFacets = ComputedFacet[];

/**
 * Live facet counts. `items` should already be search-filtered by the caller so counts reflect the query.
 * Each facet's counts are computed over the set filtered by all OTHER active facets.
 */
export function computeFacets<T>(items: T[], defs: FacetDef<T>[], filters: ActiveFilters): ComputedFacets {
  return defs.map((def) => {
    const base = applyFilters(items, defs, filters, def.key);
    const counts = new Map<string, number>();
    for (const it of base) for (const v of facetValues(def, it)) counts.set(v, (counts.get(v) ?? 0) + 1);
    let values = [...counts.entries()].map(([value, count]) => ({ value, count }));
    if (def.order) {
      const rank = new Map(def.order.map((v, i) => [v, i]));
      values = values.sort((a, b) => (rank.get(a.value) ?? 999) - (rank.get(b.value) ?? 999));
    } else {
      values = values.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    }
    return { key: def.key, label: def.label, values };
  });
}

/** Full pipeline: search → filter → sort. Returns a new array. */
export function applyPrefs<T>(items: T[], desc: CollectionDescriptor<T>, prefs: ViewPrefs): T[] {
  let r = items;
  const q = prefs.q.trim().toLowerCase();
  if (q) r = r.filter((it) => desc.searchText(it).toLowerCase().includes(q));
  r = applyFilters(r, desc.facets, prefs.filters);
  const sortDef = desc.sorts.find((s) => s.key === prefs.sort) ?? desc.sorts[0];
  if (sortDef) r = sortItems(r, sortDef, prefs.dir);
  return r;
}

/** Total count of active filter values across all facets (for the toolbar badge). */
export function activeFilterCount(filters: ActiveFilters): number {
  return Object.values(filters.enums).reduce((n, vs) => n + vs.length, 0);
}
