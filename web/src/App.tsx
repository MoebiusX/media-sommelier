import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ScanStatus } from './api';
import OverviewPage from './Overview';
import Library, { type LibraryView } from './Library';
import Organize from './Organize';
import Drives from './Drives';
import SourceBar from './SourceBar';
import { Icon } from './ui';
import { PlayerProvider } from './player';
import PlayerBar from './PlayerBar';

type Tab = 'overview' | 'library' | 'organize' | 'sync';

export default function App() {
  const [tab, setTab] = useState<Tab>('organize');
  const [libView, setLibView] = useState<LibraryView>({ kind: 'artists' });
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  const [source, setSource] = useState<string>(() => localStorage.getItem('somm.source') ?? '');
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [running, setRunning] = useState<Array<{ type: string; phase: string; done: number; total: number }>>([]);
  const polling = useRef(false);

  useEffect(() => {
    api
      .health()
      .then((h) => setApiUp(!!h.ok))
      .catch(() => setApiUp(false));
  }, []);

  // Poll the global "what's running" view so any background job is visible from anywhere.
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .activeJobs()
        .then((j) => alive && setRunning(j))
        .catch(() => {});
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('somm.source', source);
  }, [source]);

  // Start indexing a folder, then poll status until done; on success refresh the data views.
  const doScan = useCallback(async (src: string) => {
    const target = src.trim();
    if (!target || polling.current) return;
    polling.current = true;
    setScan({ state: 'running', source: target, phase: 'starting', done: 0, total: 0 });
    try {
      await api.startScan(target);
      for (;;) {
        await new Promise((r) => setTimeout(r, 1200));
        const s = await api.scanStatus();
        setScan(s);
        if (s.state === 'done') {
          setRefreshKey((k) => k + 1);
          break;
        }
        if (s.state === 'error') break;
      }
    } catch (e) {
      setScan({ state: 'error', phase: '', done: 0, total: 0, error: String((e as Error).message ?? e) });
    } finally {
      polling.current = false;
    }
  }, []);

  function gotoArtist(name: string) {
    setLibView({ kind: 'artist', name });
    setTab('library');
  }
  function navLibrary(v: LibraryView) {
    setLibView(v);
    setTab('library');
  }
  // Used by Organize's "Browse the organized library": point the source at the new tree and index it.
  function openFolder(p: string) {
    setSource(p);
    setLibView({ kind: 'artists' });
    setTab('library');
    void doScan(p);
  }
  async function pickSource() {
    const r = await api.pickFolder();
    if (r.path) setSource(r.path);
  }

  const navItem = (id: Tab, icon: 'overview' | 'library' | 'organize' | 'sync', label: string) => (
    <div
      className={'nav-item' + (tab === id ? ' active' : '')}
      onClick={() => {
        setTab(id);
        if (id === 'library') setLibView({ kind: 'artists' });
      }}
    >
      <Icon name={icon} className="nav-ico" />
      {label}
    </div>
  );

  return (
    <PlayerProvider>
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-name">Media Sommelier</div>
            <div className="brand-sub">your library, reconstructed</div>
          </div>
        </div>

        {navItem('organize', 'organize', 'Organize')}
        {navItem('library', 'library', 'Library')}
        {navItem('sync', 'sync', 'Sync')}
        {navItem('overview', 'overview', 'Overview')}

        <div className="sidebar-spacer" />
        {running.length > 0 && (
          <div className="running-box">
            {running.map((j, i) => {
              const label =
                j.type === 'scan'
                  ? 'Indexing'
                  : j.type === 'sync'
                    ? 'Syncing'
                    : j.type === 'refresh'
                      ? 'Refreshing covers'
                      : j.type === 'organize'
                        ? 'Organizing'
                        : j.type;
              return (
                <div className="running-row" key={`${j.type}-${i}`}>
                  <span className="spinner-sm" />
                  <span className="running-label">{label}</span>
                  {j.total > 0 && (
                    <span className="running-count">
                      {j.done.toLocaleString()}/{j.total.toLocaleString()}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="sidebar-foot">
          <span className="pill">
            <span className={'dot ' + (apiUp ? 'ok' : apiUp === false ? 'down' : '')} />
            {apiUp ? 'API connected' : apiUp === false ? 'API offline' : 'connecting…'}
          </span>
        </div>
      </aside>

      <main className="main">
        <div className="main-inner">
          {tab !== 'organize' && tab !== 'sync' && (
            <SourceBar
              source={source}
              setSource={setSource}
              scan={scan}
              onScan={() => void doScan(source)}
              onPick={() => void pickSource()}
            />
          )}
          {tab === 'organize' ? (
            <Organize source={source} setSource={setSource} onOpenResult={openFolder} />
          ) : tab === 'library' ? (
            <Library key={refreshKey} view={libView} navigate={navLibrary} />
          ) : tab === 'sync' ? (
            <Drives onBrowseLibrary={() => navLibrary({ kind: 'artists' })} />
          ) : (
            <OverviewPage key={refreshKey} onArtist={gotoArtist} />
          )}
        </div>
      </main>
      <PlayerBar onOpenAlbum={(id, artistName) => navLibrary({ kind: 'album', id, artistName })} />
    </div>
    </PlayerProvider>
  );
}
