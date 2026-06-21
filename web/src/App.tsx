import { useEffect, useState } from 'react';

type Health = { ok: boolean; service?: string; db?: string } | null;

const NAV = ['Library', 'Albums', 'Artists', 'Review'] as const;
type Section = (typeof NAV)[number];

export default function App() {
  const [active, setActive] = useState<Section>('Library');
  const [health, setHealth] = useState<Health>(null);
  const [healthError, setHealthError] = useState(false);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((j) => setHealth(j))
      .catch(() => setHealthError(true));
  }, []);

  const apiUp = !!health?.ok && !healthError;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-name">Media Sommelier</div>
            <div className="brand-sub">your library, reconstructed</div>
          </div>
        </div>

        {NAV.map((item) => (
          <div
            key={item}
            className={'nav-item' + (active === item ? ' active' : '')}
            onClick={() => setActive(item)}
          >
            {item}
          </div>
        ))}

        <div className="sidebar-spacer" />
        <div className="sidebar-foot">
          <span className="pill">
            <span className={'dot ' + (apiUp ? 'ok' : healthError ? 'down' : '')} />
            {apiUp ? 'API connected' : healthError ? 'API offline' : 'connecting…'}
          </span>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <h1>{active}</h1>
        </div>
        <div className="content">
          <div className="placeholder">
            <h2>{active}</h2>
            <p>
              This view is a placeholder. The app skeleton is wired up and the
              engine-backed API is {apiUp ? 'live' : 'not yet reachable'}.
            </p>
            {health?.db && (
              <p className="brand-sub">database: {health.db}</p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
