import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtDuration, fmtInt, type SearchResults } from './api';
import { usePlayer, type PlayerTrack } from './player';
import { Cover } from './ui';

type Item =
  | { kind: 'artist'; data: SearchResults['artists'][number] }
  | { kind: 'album'; data: SearchResults['albums'][number] }
  | { kind: 'track'; data: SearchResults['tracks'][number] };

/**
 * Global ⌘K / Ctrl-K command palette — instant ranked search across artists, albums and tracks.
 * ↑/↓ to move, Enter to open (artist/album) or play (track), Esc to close.
 */
export default function CommandPalette({
  open,
  onClose,
  onArtist,
  onAlbum,
}: {
  open: boolean;
  onClose: () => void;
  onArtist: (name: string) => void;
  onAlbum: (id: string, artistName?: string) => void;
}) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResults | null>(null);
  const [sel, setSel] = useState(0);
  const player = usePlayer();
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo<Item[]>(() => {
    if (!res) return [];
    return [
      ...res.artists.map((a) => ({ kind: 'artist' as const, data: a })),
      ...res.albums.map((a) => ({ kind: 'album' as const, data: a })),
      ...res.tracks.map((t) => ({ kind: 'track' as const, data: t })),
    ];
  }, [res]);

  useEffect(() => {
    if (open) {
      setQ('');
      setRes(null);
      setSel(0);
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const t = q.trim();
    if (!t) {
      setRes(null);
      return undefined;
    }
    let alive = true;
    const id = setTimeout(() => {
      api
        .search(t)
        .then((r) => {
          if (alive) {
            setRes(r);
            setSel(0);
          }
        })
        .catch(() => {});
    }, 150);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [q, open]);

  function activate(item: Item | undefined) {
    if (!item) return;
    if (item.kind === 'artist') onArtist(item.data.name);
    else if (item.kind === 'album') onAlbum(item.data.id, item.data.artistName);
    else {
      const t = item.data;
      const pt: PlayerTrack = {
        id: t.id,
        title: t.title,
        artistName: t.artistName ?? '',
        path: t.path,
        durationMs: t.durationMs,
        ...(t.albumId ? { albumId: t.albumId } : {}),
      };
      player.playQueue([pt], 0);
    }
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(items[sel]);
    }
  }

  if (!open) return null;

  let idx = -1; // running flat index across groups, for selection highlight
  const row = (item: Item, label: React.ReactNode, sub: React.ReactNode, right?: React.ReactNode) => {
    idx++;
    const i = idx;
    return (
      <div
        className={'cp-row' + (i === sel ? ' on' : '')}
        onMouseEnter={() => setSel(i)}
        onClick={() => activate(item)}
        key={`${item.kind}-${i}`}
      >
        {item.kind === 'track' ? (
          <div className="cp-ico">♪</div>
        ) : item.kind === 'album' ? (
          <div className="cp-cover">
            <Cover albumId={item.data.id} title={item.data.title} />
          </div>
        ) : (
          <div className="cp-ico">{item.data.name.replace(/^the\s+/i, '').slice(0, 1).toUpperCase()}</div>
        )}
        <div className="cp-main">
          <div className="cp-title">{label}</div>
          <div className="cp-sub">{sub}</div>
        </div>
        {right != null && <div className="cp-right">{right}</div>}
      </div>
    );
  };

  return (
    <div className="cp-backdrop" onMouseDown={onClose}>
      <div className="cp-panel" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="cp-input"
          placeholder="Search artists, albums, tracks…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
        />
        <div className="cp-results">
          {!q.trim() ? (
            <div className="cp-empty">Type to search your library.</div>
          ) : items.length === 0 ? (
            <div className="cp-empty">{res ? 'No matches.' : 'Searching…'}</div>
          ) : (
            <>
              {res!.artists.length > 0 && <div className="cp-group">Artists</div>}
              {res!.artists.map((a) =>
                row(
                  { kind: 'artist', data: a },
                  a.name,
                  `${fmtInt(a.trackCount)} tracks${a.albumCount ? ` · ${fmtInt(a.albumCount)} albums` : ''}`,
                ),
              )}
              {res!.albums.length > 0 && <div className="cp-group">Albums</div>}
              {res!.albums.map((a) =>
                row(
                  { kind: 'album', data: a },
                  a.title,
                  `${a.artistName}${a.year ? ` · ${a.year}` : ''} · ${fmtInt(a.trackCount)} tracks`,
                ),
              )}
              {res!.tracks.length > 0 && <div className="cp-group">Tracks</div>}
              {res!.tracks.map((t) =>
                row(
                  { kind: 'track', data: t },
                  t.title,
                  t.artistName ?? '',
                  <span className="cp-dur">{fmtDuration(t.durationMs)}</span>,
                ),
              )}
            </>
          )}
        </div>
        <div className="cp-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open / play</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
