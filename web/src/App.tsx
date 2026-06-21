import { useEffect, useState } from 'react';
import { api } from './api';
import OverviewPage from './Overview';
import Library, { type LibraryView } from './Library';
import { Icon } from './ui';

type Tab = 'overview' | 'library';

export default function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [libView, setLibView] = useState<LibraryView>({ kind: 'artists' });
  const [apiUp, setApiUp] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .health()
      .then((h) => setApiUp(!!h.ok))
      .catch(() => setApiUp(false));
  }, []);

  function gotoArtist(name: string) {
    setLibView({ kind: 'artist', name });
    setTab('library');
  }

  function navLibrary(v: LibraryView) {
    setLibView(v);
    setTab('library');
  }

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

        <div
          className={'nav-item' + (tab === 'overview' ? ' active' : '')}
          onClick={() => setTab('overview')}
        >
          <Icon name="overview" className="nav-ico" />
          Overview
        </div>
        <div
          className={'nav-item' + (tab === 'library' ? ' active' : '')}
          onClick={() => {
            setTab('library');
            setLibView({ kind: 'artists' });
          }}
        >
          <Icon name="library" className="nav-ico" />
          Library
        </div>

        <div className="sidebar-spacer" />
        <div className="sidebar-foot">
          <span className="pill">
            <span className={'dot ' + (apiUp ? 'ok' : apiUp === false ? 'down' : '')} />
            {apiUp ? 'API connected' : apiUp === false ? 'API offline' : 'connecting…'}
          </span>
        </div>
      </aside>

      <main className="main">
        <div className="main-inner">
          {tab === 'overview' ? (
            <OverviewPage onArtist={gotoArtist} />
          ) : (
            <Library view={libView} navigate={navLibrary} />
          )}
        </div>
      </main>
    </div>
  );
}
