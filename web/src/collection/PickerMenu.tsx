// A reusable "Add to <playlist|profile> ▾" dropdown: lazily loads its list, offers "+ New…", closes on
// outside click. Shared by the collection bulk bar and the Duplicates panel. Reuses .atp/.atp-menu classes.
import { useState } from 'react';
import { useClickOutside } from '../ui';

export interface PickItem {
  id: number;
  name: string;
  sub?: string;
}

export default function PickerMenu({
  label,
  load,
  onPick,
  onCreate,
  emptyText,
}: {
  label: string;
  load: () => Promise<PickItem[]>;
  onPick: (id: number, name: string) => void | Promise<void>;
  onCreate: (name: string) => Promise<{ id: number }>;
  emptyText: string;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PickItem[] | null>(null);
  const ref = useClickOutside<HTMLDivElement>(open, () => setOpen(false));

  const toggle = async () => {
    if (!open) {
      setItems(null);
      try {
        setItems(await load());
      } catch {
        setItems([]);
      }
    }
    setOpen((v) => !v);
  };
  const create = async () => {
    const name = window.prompt(`New ${label.toLowerCase().replace('add to ', '')} name:`)?.trim();
    if (!name) return;
    const r = await onCreate(name);
    setOpen(false);
    await onPick(r.id, name);
  };

  return (
    <div className="atp" ref={ref}>
      <button className="btn ghost" onClick={() => void toggle()}>
        {label} ▾
      </button>
      {open && (
        <div className="atp-menu" onClick={(e) => e.stopPropagation()}>
          {items === null ? (
            <div className="atp-item muted">Loading…</div>
          ) : (
            <>
              {items.map((p) => (
                <div key={p.id} className="atp-item" onClick={() => { setOpen(false); void onPick(p.id, p.name); }}>
                  <span>{p.name}</span>
                  {p.sub && <span className="muted">{p.sub}</span>}
                </div>
              ))}
              {items.length === 0 && <div className="atp-item muted">{emptyText}</div>}
              <div className="atp-item new" onClick={() => void create()}>
                + New…
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
