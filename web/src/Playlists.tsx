import { useCallback, useEffect, useState } from 'react';
import { api, fmtDuration, fmtInt, type PlaylistDetail, type PlaylistSummary, type PlaylistTrack } from './api';
import { usePlayer, type PlayerTrack } from './player';
import { Loading } from './ui';

const toPlayerTrack = (t: PlaylistTrack): PlayerTrack => ({
  id: t.id,
  title: t.title,
  artistName: t.artistName ?? '',
  path: t.path,
  durationMs: t.durationMs,
  ...(t.albumId ? { albumId: t.albumId } : {}),
  ...(t.album ? { albumTitle: t.album } : {}),
});

/** Listening playlists — create, fill (from albums/tracks elsewhere), play, reorder-by-remove, delete. */
export default function Playlists() {
  const [open, setOpen] = useState<number | null>(null);
  return open == null ? <PlaylistList onOpen={setOpen} /> : <PlaylistView id={open} onBack={() => setOpen(null)} />;
}

function PlaylistList({ onOpen }: { onOpen: (id: number) => void }) {
  const [items, setItems] = useState<PlaylistSummary[] | null>(null);
  const [name, setName] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(await api.playlists());
    } catch {
      setItems([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    const n = name.trim();
    if (!n) return;
    await api.createPlaylist(n);
    setName('');
    void load();
  }

  return (
    <>
      <h1 className="page-title">Playlists</h1>
      <p className="page-lede">Build listening sets from anything in your library — add tracks or whole albums.</p>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="sb-row">
          <input
            className="sb-input"
            placeholder="New playlist name — e.g. Road Trip, Focus, Sunday"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
          <button className="btn primary" onClick={() => void create()} disabled={!name.trim()}>
            Create
          </button>
        </div>
      </div>
      {!items ? (
        <Loading label="Loading playlists…" />
      ) : items.length === 0 ? (
        <div className="empty">No playlists yet. Create one above, then add tracks from an album or search.</div>
      ) : (
        <div className="panel" style={{ padding: 8 }}>
          <div className="list">
            {items.map((p) => (
              <div className="row" key={p.id} onClick={() => onOpen(p.id)}>
                <div className="avatar">♪</div>
                <div className="row-main">
                  <div className="row-title">{p.name}</div>
                  <div className="row-sub">{fmtInt(p.trackCount)} tracks</div>
                </div>
                <Icon />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

const Icon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="chev">
    <path d="m9 18 6-6-6-6" />
  </svg>
);

function PlaylistView({ id, onBack }: { id: number; onBack: () => void }) {
  const [data, setData] = useState<PlaylistDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const player = usePlayer();

  const load = useCallback(async () => {
    try {
      const d = await api.playlist(id);
      setData(d);
      setName(d.name);
    } catch {
      onBack();
    }
  }, [id, onBack]);
  useEffect(() => {
    void load();
  }, [load]);

  const queue = data?.tracks.map(toPlayerTrack) ?? [];

  async function remove(path: string) {
    await api.removeFromPlaylist(id, path);
    await load();
  }
  async function del() {
    if (!confirm(`Delete playlist “${data?.name}”?`)) return;
    await api.deletePlaylist(id);
    onBack();
  }
  async function saveName() {
    const n = name.trim();
    setEditing(false);
    if (n && n !== data?.name) {
      await api.renamePlaylist(id, n);
      await load();
    }
  }

  return (
    <>
      <div className="breadcrumb">
        <span className="crumb" onClick={onBack}>
          Playlists
        </span>
        <span className="sep">/</span>
        <span className="here">{data?.name ?? '…'}</span>
      </div>
      {!data ? (
        <Loading label="Loading…" />
      ) : (
        <>
          <div className="pl-head">
            {editing ? (
              <input
                className="sb-input pl-name-input"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void saveName()}
                onKeyDown={(e) => e.key === 'Enter' && void saveName()}
              />
            ) : (
              <h1 className="page-title" onClick={() => setEditing(true)} title="Click to rename">
                {data.name}
              </h1>
            )}
            <div className="pl-actions">
              <button className="btn primary" onClick={() => queue.length && player.playQueue(queue, 0)} disabled={queue.length === 0}>
                ▶ Play
              </button>
              <button className="btn ghost" onClick={() => void del()}>
                Delete
              </button>
            </div>
          </div>
          <p className="page-lede">{fmtInt(data.tracks.length)} tracks</p>
          {data.tracks.length === 0 ? (
            <div className="empty">Empty. Add tracks from an album page or the ⌘K search.</div>
          ) : (
            <div className="tracks">
              {data.tracks.map((t, i) => {
                const active = player.current?.path === t.path;
                return (
                  <div className={'trk pl-trk' + (active ? ' active' : '')} key={t.path}>
                    <div className="no" onClick={() => (active ? player.toggle() : player.playQueue(queue, i))}>
                      {active ? (
                        <span className={'eq' + (player.isPlaying ? ' on' : '')}>
                          <i />
                          <i />
                          <i />
                        </span>
                      ) : (
                        i + 1
                      )}
                    </div>
                    <div onClick={() => (active ? player.toggle() : player.playQueue(queue, i))}>
                      <div className="tt" title={t.title}>
                        {t.title}
                      </div>
                      {t.artistName && <div className="tsub">{t.artistName}</div>}
                    </div>
                    <div className="meta">{t.lossless ? 'FLAC' : t.bitrateKbps ? `${t.bitrateKbps} kbps` : ''}</div>
                    <div className="meta">{fmtDuration(t.durationMs)}</div>
                    <button className="icon-btn pl-remove" title="Remove from playlist" onClick={() => void remove(t.path)}>
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}
