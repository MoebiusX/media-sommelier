// App sidebar: grouped navigation (Listen / Manage / Overview), a now-playing card, a collapse toggle
// (icon-only rail) and a drag-to-resize handle. Lives INSIDE <PlayerProvider> so it can show now-playing.
import { useEffect, useRef, useState } from 'react';
import { usePlayer } from './player';
import { Icon, Cover } from './ui';
import { AutoDjPicker } from './AutoDj';

export type Tab = 'overview' | 'library' | 'organize' | 'sync' | 'playlists';
type Job = { type: string; phase: string; done: number; total: number };

const WIDTH_MIN = 200;
const WIDTH_MAX = 360;
const WIDTH_DEFAULT = 248;

const SearchIco = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);
const Radio = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4.5 9.5 18 4" />
    <rect x="3" y="9" width="18" height="11" rx="2" />
    <circle cx="8" cy="14.5" r="2.5" />
    <path d="M16 13.5v2" />
  </svg>
);
const Collapse = ({ collapsed }: { collapsed: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden
    style={{ transform: collapsed ? 'rotate(180deg)' : undefined }}>
    <path d="m13 17-5-5 5-5" />
    <path d="M18 6v12" />
  </svg>
);

export default function Sidebar({
  tab,
  onNavigate,
  onSearch,
  onOpenAlbum,
  running,
  apiUp,
}: {
  tab: Tab;
  onNavigate: (t: Tab) => void;
  onSearch: () => void;
  onOpenAlbum: (albumId: string, artistName: string) => void;
  running: Job[];
  apiUp: boolean | null;
}) {
  const p = usePlayer();
  const [collapsed, setCollapsed] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem('somm.nav.collapsed') === '1',
  );
  const [width, setWidth] = useState<number>(() => {
    const v = Number(typeof localStorage !== 'undefined' ? localStorage.getItem('somm.nav.width') : null);
    return v >= WIDTH_MIN && v <= WIDTH_MAX ? v : WIDTH_DEFAULT;
  });
  const [showDj, setShowDj] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;
  const draggingRef = useRef(false);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const n = !c;
      try {
        localStorage.setItem('somm.nav.collapsed', n ? '1' : '0');
      } catch {
        /* ignore */
      }
      return n;
    });

  // Drag-to-resize: the handle sets dragging; window listeners track the move and persist on release.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const w = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, e.clientX));
      widthRef.current = w; // keep the ref current so mouseup persists the right value
      setWidth(w);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.classList.remove('resizing');
      try {
        localStorage.setItem('somm.nav.width', String(Math.round(widthRef.current)));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startDrag = () => {
    if (collapsed) return;
    draggingRef.current = true;
    document.body.classList.add('resizing');
  };

  const cur = p.current;
  const navBtn = (id: Tab, icon: 'overview' | 'library' | 'organize' | 'sync' | 'playlist', label: string) => (
    <button
      className={'nav-item' + (tab === id ? ' active' : '')}
      onClick={() => onNavigate(id)}
      title={collapsed ? label : undefined}
    >
      <Icon name={icon} className="nav-ico" />
      {!collapsed && <span className="nav-label">{label}</span>}
    </button>
  );

  return (
    <aside className={'sidebar' + (collapsed ? ' collapsed' : '')} style={collapsed ? undefined : { width }}>
      <div className="brand">
        <div className="brand-mark" />
        {!collapsed && (
          <div className="brand-text">
            <div className="brand-name">Media Sommelier</div>
            <div className="brand-sub">your library, reconstructed</div>
          </div>
        )}
        <button className="nav-collapse" onClick={toggleCollapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand' : 'Collapse'}>
          <Collapse collapsed={collapsed} />
        </button>
      </div>

      <button className={'sidebar-search' + (collapsed ? ' icon' : '')} onClick={onSearch} title="Search (⌘K)">
        <SearchIco />
        {!collapsed && (
          <>
            <span>Search…</span>
            <kbd>⌘K</kbd>
          </>
        )}
      </button>

      <nav className="nav">
        {!collapsed && <div className="nav-group-label">Listen</div>}
        {navBtn('library', 'library', 'Library')}
        {navBtn('playlists', 'playlist', 'Playlists')}
        <button
          className={'nav-item dj' + (p.autoDj ? ' active' : '')}
          onClick={() => setShowDj(true)}
          title={collapsed ? (p.autoDj ? `Auto DJ · ${p.autoDj.label}` : 'Auto DJ') : undefined}
        >
          <Radio />
          {!collapsed && <span className="nav-label">{p.autoDj ? `Auto DJ · ${p.autoDj.label}` : 'Auto DJ'}</span>}
          {!collapsed && p.autoDj && <span className="nav-live">LIVE</span>}
          {collapsed && p.autoDj && <span className="nav-live-dot" />}
        </button>

        {collapsed ? <div className="nav-sep" /> : <div className="nav-group-label">Manage</div>}
        {navBtn('organize', 'organize', 'Organize')}
        {navBtn('sync', 'sync', 'Sync')}

        {collapsed ? <div className="nav-sep" /> : <div className="nav-group-label">Overview</div>}
        {navBtn('overview', 'overview', 'Overview')}
      </nav>

      <div className="sidebar-spacer" />

      {cur && (
        <button
          className={'np-card' + (collapsed ? ' icon' : '')}
          onClick={() => cur.albumId && onOpenAlbum(cur.albumId, cur.artistName)}
          title={collapsed ? `${cur.title} — ${cur.artistName}` : cur.albumId ? 'Open album' : undefined}
          disabled={!cur.albumId}
        >
          {cur.albumId ? (
            <div className="np-cover">
              <Cover albumId={cur.albumId} title={cur.albumTitle ?? cur.title} />
            </div>
          ) : (
            <div className="np-cover np-cover-empty">♪</div>
          )}
          {!collapsed && (
            <>
              <div className="np-text">
                <div className="np-title">{cur.title}</div>
                <div className="np-artist">{cur.artistName}</div>
              </div>
              <span className={'eq' + (p.isPlaying ? ' on' : '')} aria-hidden>
                <i />
                <i />
                <i />
              </span>
            </>
          )}
        </button>
      )}

      {running.length > 0 && !collapsed && (
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
        <span className="pill" title={apiUp ? 'API connected' : apiUp === false ? 'API offline' : 'connecting…'}>
          <span className={'dot ' + (apiUp ? 'ok' : apiUp === false ? 'down' : '')} />
          {!collapsed && (apiUp ? 'API connected' : apiUp === false ? 'API offline' : 'connecting…')}
        </span>
      </div>

      {!collapsed && <div className="sidebar-resize" onMouseDown={startDrag} aria-hidden />}
      <AutoDjPicker open={showDj} onClose={() => setShowDj(false)} />
    </aside>
  );
}
