// The reusable control bar: search · sort + direction · layout · density · cover-size · Filters popover ·
// inline (pinned) facet chips · active-filter chips · result count. Presentational — all state flows through
// the useViewPrefs api. Reuses existing classes/tokens (.search, .sb-input, .decade/.decade-chips, .btn,
// .icon-btn, .atp-menu, .list-count) and the useClickOutside hook.
import { useEffect, useState } from 'react';
import { useClickOutside } from '../ui';
import { fmtInt } from '../api';
import type { CollectionDescriptor, LayoutMode, ViewPrefs } from './types';
import type { ViewPrefsApi } from './useViewPrefs';
import { activeFilterCount, type ComputedFacets } from './facets';
import { addSavedView, removeSavedView, viewsFor, type SavedView } from './savedViews';

const LayoutIcon = ({ mode }: { mode: LayoutMode }) => {
  const c = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (mode === 'grid')
    return (
      <svg {...c}>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
    );
  if (mode === 'table')
    return (
      <svg {...c}>
        <rect x="3" y="4" width="18" height="16" rx="1.5" />
        <path d="M3 9h18M9 4v16" />
      </svg>
    );
  return (
    <svg {...c}>
      <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </svg>
  );
};

const LAYOUT_LABEL: Record<LayoutMode, string> = { list: 'List', grid: 'Grid', table: 'Table' };

/** "Views ▾" menu — save the current sort/layout/filters as a named preset, or apply/delete a saved one. */
function SavedViewsMenu({ viewKey, prefs, onApply }: { viewKey: string; prefs: ViewPrefs; onApply: (p: ViewPrefs) => void }) {
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<SavedView[]>(() => viewsFor(viewKey));
  const ref = useClickOutside<HTMLDivElement>(open, () => setOpen(false));
  useEffect(() => setViews(viewsFor(viewKey)), [viewKey]);

  const save = () => {
    const name = window.prompt('Save this view as:')?.trim();
    if (!name) return;
    addSavedView(name, viewKey, prefs);
    setViews(viewsFor(viewKey));
    setOpen(false);
  };
  const remove = (id: string) => {
    removeSavedView(id);
    setViews(viewsFor(viewKey));
  };

  return (
    <div className="atp" ref={ref}>
      <button className="btn ghost" onClick={() => setOpen((v) => !v)}>
        Views ▾
      </button>
      {open && (
        <div className="atp-menu cview-views" onClick={(e) => e.stopPropagation()}>
          {views.length === 0 && <div className="atp-item muted">No saved views yet</div>}
          {views.map((v) => (
            <div key={v.id} className="atp-item" onClick={() => { onApply(v.prefs); setOpen(false); }}>
              <span>{v.name}</span>
              <button className="icon-btn" title="Delete view" onClick={(e) => { e.stopPropagation(); remove(v.id); }}>
                ✕
              </button>
            </div>
          ))}
          <div className="atp-item new" onClick={save}>
            + Save current view…
          </div>
        </div>
      )}
    </div>
  );
}

export default function CollectionToolbar<T>({
  descriptor,
  prefsApi,
  facets,
  shown,
  total,
  extraCount,
}: {
  descriptor: CollectionDescriptor<T>;
  prefsApi: ViewPrefsApi;
  facets: ComputedFacets;
  shown: number;
  total: number;
  /** Optional trailing text in the count line (e.g. "· 2 selected"). */
  extraCount?: string;
}) {
  const { prefs, set, update, setFilter, toggleFilterValue, clearFilters } = prefsApi;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersRef = useClickOutside<HTMLDivElement>(filtersOpen, () => setFiltersOpen(false));
  const nActive = activeFilterCount(prefs.filters);

  const setSort = (key: string) => {
    const def = descriptor.sorts.find((s) => s.key === key);
    update({ sort: key, dir: def?.defaultDir ?? 'asc' });
  };

  const pinned = descriptor.facets.filter((f) => f.pinned);
  const popover = descriptor.facets.filter((f) => !f.pinned);
  const facetByKey = new Map(facets.map((f) => [f.key, f]));
  const labelByKey = new Map(descriptor.facets.map((f) => [f.key, f.label]));

  return (
    <div className="cview-toolbar-wrap">
      <div className="cview-toolbar">
        <input
          className="search"
          style={{ margin: 0, flex: 1, minWidth: 140 }}
          placeholder={descriptor.searchPlaceholder}
          value={prefs.q}
          onChange={(e) => set('q', e.target.value)}
        />

        <div className="cview-sort">
          <select
            className="sb-input"
            style={{ width: 'auto', flex: 'none' }}
            value={prefs.sort}
            onChange={(e) => setSort(e.target.value)}
            aria-label="Sort by"
          >
            {descriptor.sorts.map((s) => (
              <option key={s.key} value={s.key}>
                Sort: {s.label}
              </option>
            ))}
          </select>
          <button
            className="icon-btn cview-dir"
            title={prefs.dir === 'asc' ? 'Ascending' : 'Descending'}
            aria-label={prefs.dir === 'asc' ? 'Sort ascending' : 'Sort descending'}
            onClick={() => set('dir', prefs.dir === 'asc' ? 'desc' : 'asc')}
          >
            {prefs.dir === 'asc' ? '↑' : '↓'}
          </button>
        </div>

        {descriptor.layouts.length > 1 && (
          <div className="seg" role="group" aria-label="Layout">
            {descriptor.layouts.map((m) => (
              <button
                key={m}
                className={prefs.layout === m ? 'on' : ''}
                title={LAYOUT_LABEL[m]}
                aria-label={LAYOUT_LABEL[m]}
                aria-pressed={prefs.layout === m}
                onClick={() => set('layout', m)}
              >
                <LayoutIcon mode={m} />
              </button>
            ))}
          </div>
        )}

        <div className="seg" role="group" aria-label="Density">
          <button className={prefs.density === 'comfortable' ? 'on' : ''} aria-pressed={prefs.density === 'comfortable'} onClick={() => set('density', 'comfortable')}>
            Cozy
          </button>
          <button className={prefs.density === 'compact' ? 'on' : ''} aria-pressed={prefs.density === 'compact'} onClick={() => set('density', 'compact')}>
            Compact
          </button>
        </div>

        {prefs.layout === 'grid' && (
          <input
            className="cview-size"
            type="range"
            min={120}
            max={260}
            step={4}
            value={prefs.coverSize}
            onChange={(e) => set('coverSize', Number(e.target.value))}
            aria-label="Cover size"
            title="Cover size"
          />
        )}

        {popover.length > 0 && (
          <div className="cview-filters-anchor" ref={filtersRef}>
            <button className={'btn ghost' + (nActive > 0 ? ' cview-filters-on' : '')} onClick={() => setFiltersOpen((v) => !v)}>
              Filters{nActive > 0 ? ` · ${nActive}` : ''} ▾
            </button>
            {filtersOpen && (
              <div className="cview-filters atp-menu">
                {popover.map((f) => {
                  const computed = facetByKey.get(f.key);
                  const sel = prefs.filters.enums[f.key] ?? [];
                  if (!computed || computed.values.length === 0) return null;
                  return (
                    <div className="cview-facet" key={f.key}>
                      <div className="cview-facet-label">{f.label}</div>
                      <div className="decade-chips">
                        {computed.values.map((v) => (
                          <button
                            key={v.value}
                            className={'decade' + (sel.includes(v.value) ? ' on' : '')}
                            onClick={() => toggleFilterValue(f.key, v.value)}
                          >
                            {v.value} <span className="facet-count">{fmtInt(v.count)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {nActive > 0 && (
                  <button className="btn ghost cview-clear" onClick={clearFilters}>
                    Clear all filters
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <SavedViewsMenu viewKey={descriptor.viewKey} prefs={prefs} onApply={(p) => update(p)} />
      </div>

      {pinned.map((f) => {
        const computed = facetByKey.get(f.key);
        if (!computed || computed.values.length === 0) return null;
        const sel = prefs.filters.enums[f.key] ?? [];
        const values = [...computed.values].sort((a, b) => a.value.localeCompare(b.value));
        return (
          <div className="decade-chips" key={f.key}>
            <button className={'decade' + (sel.length === 0 ? ' on' : '')} onClick={() => setFilter(f.key, [])}>
              All
            </button>
            {values.map((v) => (
              <button
                key={v.value}
                className={'decade' + (sel.includes(v.value) ? ' on' : '')}
                onClick={() => setFilter(f.key, sel.includes(v.value) ? [] : [v.value])}
              >
                {v.value}
              </button>
            ))}
          </div>
        );
      })}

      {nActive > 0 && (
        <div className="decade-chips cview-active">
          {Object.entries(prefs.filters.enums).flatMap(([key, vals]) =>
            vals.map((v) => (
              <button key={key + ':' + v} className="decade on cview-active-chip" onClick={() => toggleFilterValue(key, v)} title="Remove filter">
                {labelByKey.get(key) ?? key}: {v} ✕
              </button>
            )),
          )}
          <button className="decade cview-clear-inline" onClick={clearFilters}>
            Clear all
          </button>
        </div>
      )}

      <div className="list-count">
        Showing {fmtInt(shown)} of {fmtInt(total)} {descriptor.countNoun}
        {extraCount ? ` ${extraCount}` : ''}
      </div>
    </div>
  );
}
