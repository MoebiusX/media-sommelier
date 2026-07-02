import { Cover, Icon } from '../../ui';
import { isCoverRef, type CollectionDescriptor, type Density } from '../types';
import type { SelectionApi } from '../useSelection';

/** Vertical list of `.row`s — the shape ArtistsList/Playlists use today, generalized over any descriptor. */
export default function ListRenderer<T>({
  items,
  descriptor,
  density,
  selection,
}: {
  items: T[];
  descriptor: CollectionDescriptor<T>;
  density: Density;
  selection?: SelectionApi;
}) {
  return (
    <div className="panel" style={{ padding: 8 }}>
      <div className={'list' + (density === 'compact' ? ' compact' : '')}>
        {items.map((it) => {
          const id = descriptor.id(it);
          const d = descriptor.toDisplay(it);
          const sel = !!selection && !!d.selectable;
          return (
            <div key={id} className={'row' + (sel && selection!.isSelected(id) ? ' selected' : '')} onClick={d.onOpen}>
              {sel && (
                <input
                  type="checkbox"
                  className="csel"
                  checked={selection!.isSelected(id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => selection!.toggle(id)}
                  aria-label={`Select ${d.title}`}
                />
              )}
              {d.thumb ? (
                isCoverRef(d.thumb) ? (
                  <div className="row-cover">
                    <Cover albumId={d.thumb.albumId} title={d.thumb.title} />
                  </div>
                ) : (
                  <div className="avatar">{d.thumb.initials}</div>
                )
              ) : null}
              <div className="row-main">
                <div className="row-title">{d.title}</div>
                {d.sub != null && <div className="row-sub">{d.sub}</div>}
              </div>
              {d.badges}
              <Icon name="chevron" className="chev" />
            </div>
          );
        })}
      </div>
    </div>
  );
}
