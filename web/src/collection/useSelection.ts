// Ephemeral multi-select for a collection view — a Set of item ids that resets when the view changes.
// Not persisted (selection is a transient action state, unlike ViewPrefs).
import { useCallback, useEffect, useMemo, useState } from 'react';

export interface SelectionApi {
  selected: Set<string>;
  size: number;
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Replace the selection with exactly these ids. */
  set: (ids: string[]) => void;
  clear: () => void;
}

export function useSelection(resetKey: string): SelectionApi {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // A new view (or navigating away and back) starts with a clean selection.
  useEffect(() => {
    setSelected(new Set());
  }, [resetKey]);

  const toggle = useCallback((id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);
  const set = useCallback((ids: string[]) => setSelected(new Set(ids)), []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const isSelected = useCallback((id: string) => selected.has(id), [selected]);

  return useMemo(
    () => ({ selected, size: selected.size, isSelected, toggle, set, clear }),
    [selected, isSelected, toggle, set, clear],
  );
}
