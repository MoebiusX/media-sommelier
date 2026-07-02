import { type CSSProperties } from 'react';
import { Cover } from '../../ui';
import { isCoverRef, type CollectionDescriptor } from '../types';
import type { SelectionApi } from '../useSelection';

/** Cover grid — the shape AlbumsBrowse uses today. Cover size is driven by the --cover-min CSS var. */
export default function GridRenderer<T>({
  items,
  descriptor,
  coverSize,
  selection,
}: {
  items: T[];
  descriptor: CollectionDescriptor<T>;
  coverSize: number;
  selection?: SelectionApi;
}) {
  return (
    <div className="album-grid" style={{ '--cover-min': `${coverSize}px` } as CSSProperties}>
      {items.map((it) => {
        const id = descriptor.id(it);
        const d = descriptor.toDisplay(it);
        const cover = d.thumb && isCoverRef(d.thumb);
        const sel = !!selection && !!d.selectable;
        return (
          <div key={id} className={'album-card' + (sel && selection!.isSelected(id) ? ' selected' : '')} onClick={d.onOpen}>
            {sel && (
              <input
                type="checkbox"
                className="csel csel-grid"
                checked={selection!.isSelected(id)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => selection!.toggle(id)}
                aria-label={`Select ${d.title}`}
              />
            )}
            {cover ? (
              <Cover albumId={(d.thumb as { albumId: string }).albumId} title={d.title} />
            ) : (
              <div className="cover">
                <div className="cover-fallback">{d.thumb && !isCoverRef(d.thumb) ? d.thumb.initials : '♪'}</div>
              </div>
            )}
            <div className="album-meta">
              <div className="album-name" title={d.title}>
                {d.title}
              </div>
              {d.sub != null && <div className="album-line">{d.sub}</div>}
              {d.badges}
            </div>
          </div>
        );
      })}
    </div>
  );
}
