// Orchestrator: prefs → facet counts → filtered/sorted/paginated items → toolbar + the active renderer.
// Each browse surface becomes a one-liner: <CollectionView descriptor={…} items={…} />.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { fmtInt } from '../api';
import { defaultPrefs, type CollectionDescriptor } from './types';
import { useViewPrefs } from './useViewPrefs';
import { applyPrefs, computeFacets } from './facets';
import { useSelection } from './useSelection';
import CollectionToolbar from './CollectionToolbar';
import BulkBar, { type SelectedInfo } from './BulkBar';
import ListRenderer from './renderers/ListRenderer';
import GridRenderer from './renderers/GridRenderer';
import TableRenderer from './renderers/TableRenderer';

export default function CollectionView<T>({
  descriptor,
  items,
  pageSize = 120,
  emptyText = () => 'Nothing matches.',
}: {
  descriptor: CollectionDescriptor<T>;
  items: T[];
  pageSize?: number;
  emptyText?: (q: string) => ReactNode;
}) {
  const defaults = useMemo(() => defaultPrefs(descriptor), [descriptor]);
  const prefsApi = useViewPrefs(descriptor.viewKey, defaults);
  const { prefs, update } = prefsApi;
  const selection = useSelection(descriptor.viewKey);

  // search-filtered set feeds the facet counts, so counts reflect the current query
  const searched = useMemo(() => {
    const q = prefs.q.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => descriptor.searchText(it).toLowerCase().includes(q));
  }, [items, prefs.q, descriptor]);

  const facets = useMemo(
    () => computeFacets(searched, descriptor.facets, prefs.filters),
    [searched, descriptor, prefs.filters],
  );
  const result = useMemo(() => applyPrefs(items, descriptor, prefs), [items, descriptor, prefs]);

  const selectedItems = useMemo<SelectedInfo[]>(() => {
    if (selection.size === 0) return [];
    const out: SelectedInfo[] = [];
    for (const it of result) {
      const id = descriptor.id(it);
      if (selection.selected.has(id)) {
        const d = descriptor.toDisplay(it);
        out.push({ id, title: d.title, bulk: d.bulk, playable: d.playable });
      }
    }
    return out;
  }, [result, selection, descriptor]);

  const [limit, setLimit] = useState(pageSize);
  useEffect(() => setLimit(pageSize), [prefs.q, prefs.filters, prefs.sort, prefs.dir, pageSize]);
  const shown = result.slice(0, limit);

  // Table header click ↔ toolbar sort menu share one source of truth (prefs.sort/dir). Header clicks follow
  // the conventional "ascending first, click again to reverse" table behavior; the sort menu keeps each
  // sort's defaultDir (e.g. "Newest" → descending).
  const onSort = (key: string) => {
    if (key === prefs.sort) update({ dir: prefs.dir === 'asc' ? 'desc' : 'asc' });
    else update({ sort: key, dir: 'asc' });
  };

  return (
    <>
      <CollectionToolbar
        descriptor={descriptor}
        prefsApi={prefsApi}
        facets={facets}
        shown={shown.length}
        total={result.length}
        extraCount={selection.size > 0 ? `· ${selection.size} selected` : undefined}
      />
      {selection.size > 0 && <BulkBar items={selectedItems} onClear={selection.clear} />}
      {result.length === 0 ? (
        <div className="empty">{emptyText(prefs.q.trim())}</div>
      ) : (
        <>
          {prefs.layout === 'grid' ? (
            <GridRenderer items={shown} descriptor={descriptor} coverSize={prefs.coverSize} selection={selection} />
          ) : prefs.layout === 'table' ? (
            <TableRenderer items={shown} descriptor={descriptor} density={prefs.density} sort={prefs.sort} dir={prefs.dir} onSort={onSort} selection={selection} />
          ) : (
            <ListRenderer items={shown} descriptor={descriptor} density={prefs.density} selection={selection} />
          )}
          {result.length > shown.length && (
            <button className="load-more" onClick={() => setLimit((n) => n + pageSize)}>
              Show {fmtInt(Math.min(pageSize, result.length - shown.length))} more
            </button>
          )}
        </>
      )}
    </>
  );
}
