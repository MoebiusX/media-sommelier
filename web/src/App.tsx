import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { parseHash, replaceHash } from './collection/hashState';

const TABS: Tab[] = ['overview', 'library', 'organize', 'sync', 'playlists'];
function decodeTab(t: string | undefined): Tab | null {
  return t && (TABS as string[]).includes(t) ? (t as Tab) : null;
}
function decodeView(v: string | undefined): LibraryView | null {
  if (!v) return null;
  if (v === 'artists') return { kind: 'artists' };
  if (v === 'albums') return { kind: 'albums' };
  const i = v.indexOf(':');
  if (i > 0) {
    const kind = v.slice(0, i);
    const rest = decodeURIComponent(v.slice(i + 1));
    if (kind === 'artist') return { kind: 'artist', name: rest };
    if (kind === 'album') return { kind: 'album', id: rest };
  }
  return null;
}
function encodeView(v: LibraryView): string {
  if (v.kind === 'artists' || v.kind === 'albums') return v.kind;
  if (v.kind === 'artist') return `artist:${encodeURIComponent(v.name)}`;
  return `album:${encodeURIComponent(v.id)}`;
}

export default function App() {
  // Restore the tab + Library view from the URL hash on first mount (shared link / reload); default otherwise.
  const initialHash = useMemo(() => parseHash(), []);
  const [tab, setTab] = useState<Tab>(() => decodeTab(initialHash.t) ?? 'library');
  const [libView, setLibView] = useState<LibraryView>(() => decodeView(initialHash.v) ?? { kind: 'artists' });

  // Keep the hash in sync so a reload / shared link lands on the same place (view prefs persist separately).
  useEffect(() => {
    replaceHash({ t: tab, v: encodeView(libView) });
  }, [tab, libView]);

  // A shared #link opened (or edited) in an already-running tab should navigate too. history.replaceState
  // (above) doesn't fire 'hashchange', so this only reacts to genuine user hash navigation — no loop.
  useEffect(() => {
    const onHash = () => {
      const h = parseHash();
      const t = decodeTab(h.t);
      const v = decodeView(h.v);
      if (t) setTab(t);
      if (v) setLibView(v);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
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
