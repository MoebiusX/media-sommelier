// Named, optionally-pinned view presets, persisted to `somm.savedViews`. A saved view captures a viewKey +
// its ViewPrefs so the user can re-apply a filtered/sorted/laid-out configuration in one click. Wired into the
// toolbar's "Views" menu in the power-user phase.
import type { ViewPrefs } from './types';

export interface SavedView {
  id: string;
  name: string;
  viewKey: string;
  prefs: ViewPrefs;
  pinned: boolean;
  createdAt: number;
}

const KEY = 'somm.savedViews';

/** Collision-resistant id without a dependency (nanoid etc.). */
export function newViewId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function loadSavedViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedView[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(list: SavedView[]): SavedView[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}

export function viewsFor(viewKey: string): SavedView[] {
  return loadSavedViews().filter((v) => v.viewKey === viewKey);
}

export function addSavedView(name: string, viewKey: string, prefs: ViewPrefs): SavedView[] {
  const view: SavedView = { id: newViewId(), name, viewKey, prefs, pinned: false, createdAt: 0 };
  return write([...loadSavedViews(), view]);
}

export function removeSavedView(id: string): SavedView[] {
  return write(loadSavedViews().filter((v) => v.id !== id));
}

export function togglePin(id: string): SavedView[] {
  return write(loadSavedViews().map((v) => (v.id === id ? { ...v, pinned: !v.pinned } : v)));
}
