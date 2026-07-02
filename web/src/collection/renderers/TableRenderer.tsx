import type { CollectionDescriptor, Density, SortDir } from '../types';
import type { SelectionApi } from '../useSelection';

/** Dense sortable table. Header clicks drive the SAME prefs.sort/dir as the toolbar sort menu (one source of
 *  truth). A leading checkbox column appears when the items are selectable. */
export default function TableRenderer<T>({
  items,
  descriptor,
  density,
  sort,
  dir,
  onSort,
  selection,
}: {
  items: T[];
  descriptor: CollectionDescriptor<T>;
  density: Density;
  sort: string;
  dir: SortDir;
  onSort: (key: string) => void;
  selection?: SelectionApi;
}) {
  const cols = descriptor.columns.filter((c) => density === 'comfortable' || c.primary !== false);
  const selectable = !!selection && items.some((it) => descriptor.toDisplay(it).selectable);
  const visibleIds = items.map((it) => descriptor.id(it));
  const allSelected = selectable && visibleIds.length > 0 && visibleIds.every((id) => selection!.isSelected(id));
  const toggleAll = () => selection!.set(allSelected ? [] : visibleIds);

  return (
    <div className={'ctable-wrap' + (density === 'compact' ? ' compact' : '')}>
      <table className="ctable">
        <thead>
          <tr>
            {selectable && (
              <th className="ct-sel">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
              </th>
            )}
            {cols.map((c) => {
              const sortable = !!c.sortValue;
              const active = c.key === sort;
              return (
                <th
                  key={c.key}
                  className={(c.align === 'right' ? 'r ' : '') + (sortable ? 'sortable ' : '') + (active ? 'active' : '')}
                  aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  onClick={sortable ? () => onSort(c.key) : undefined}
                >
                  {c.label}
                  {active ? <span className="ct-arrow">{dir === 'asc' ? ' ▲' : ' ▼'}</span> : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const id = descriptor.id(it);
            const d = descriptor.toDisplay(it);
            const sel = selectable && !!d.selectable;
            return (
              <tr key={id} className={sel && selection!.isSelected(id) ? 'selected' : undefined} onClick={d.onOpen}>
                {selectable && (
                  <td className="ct-sel" onClick={(e) => e.stopPropagation()}>
                    {sel && (
                      <input
                        type="checkbox"
                        checked={selection!.isSelected(id)}
                        onChange={() => selection!.toggle(id)}
                        aria-label={`Select ${d.title}`}
                      />
                    )}
                  </td>
                )}
                {cols.map((c) => (
                  <td key={c.key} className={c.align === 'right' ? 'r' : undefined}>
                    {c.render(it)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
