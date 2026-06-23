// Light/dark theming. The actual swap is CSS — variables under :root (dark) and :root[data-theme='light']
// in styles.css. This module just decides which is active and writes <html data-theme="…">.
// Initial application happens via an inline script in index.html (avoids a flash); this keeps it in sync.
export type Theme = 'light' | 'dark';

const KEY = 'somm.theme';

/** The OS preference, used when the user hasn't picked a theme. */
export function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

/** The user's explicit choice, or null if they've never picked one. */
export function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/** The theme to show now: the user's choice if any, else the OS preference. */
export function currentTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

/** Persist + apply a theme choice. */
export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode / quota — non-fatal */
  }
  applyTheme(t);
}
