import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ScanStatus } from './api';
import OverviewPage from './Overview';
import Library, { type LibraryView } from './Library';
import Organize from './Organize';
import Drives from './Drives';
import Playlists from './Playlists';
import SourceBar from './SourceBar';
import { PlayerProvider } from './player';
import PlayerBar from './PlayerBar';
import CommandPalette from './CommandPalette';
import Sidebar, { type Tab } from './Sidebar';

export default function App() {
  const [tab, setTab] = useState<Tab>('library');
  const [libView, setLibView] = useState<LibraryView>({ kind: 'artists' });
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  const [source, setSource] = useState<string>(() => localStorage.getItem('somm.source') ?? '');
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [running, setRunning] = useState<Array<{ type: string; phase: string; done: number; total: number }>>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const polling = useRef(false);

  // Global ⌘K / Ctrl-K to open the search command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  function navTo(t: Tab) {
    setTab(t);
    if (t === 'library') setLibView({ kind: 'artists' });
  }

  return (
    <PlayerProvider>
    <div className="app">
      <Sidebar
        tab={tab}
        onNavigate={navTo}
        onSearch={() => setPaletteOpen(true)}
        onOpenAlbum={(id, artistName) => navLibrary({ kind: 'album', id, artistName })}
        running={running}
        apiUp={apiUp}
      />

      <main className="main">
        <div className="main-inner">
          {tab !== 'organize' && tab !== 'sync' && tab !== 'playlists' && (
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
          ) : tab === 'playlists' ? (
            <Playlists />
          ) : (
            <OverviewPage key={refreshKey} onArtist={gotoArtist} />
          )}
        </div>
      </main>
      <PlayerBar onOpenAlbum={(id, artistName) => navLibrary({ kind: 'album', id, artistName })} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onArtist={gotoArtist}
        onAlbum={(id, artistName) => navLibrary({ kind: 'album', id, artistName })}
      />
    </div>
    </PlayerProvider>
  );
}
