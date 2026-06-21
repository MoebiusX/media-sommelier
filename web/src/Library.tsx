import { useEffect, useMemo, useState } from 'react';
import {
  api,
  fmtDuration,
  fmtInt,
  type AlbumDetail,
  type AlbumSummary,
  type ArtistDetail,
  type ArtistSummary,
  type ProfileSummary,
} from './api';
import { Cover, ErrorState, FlagBadges, Icon, Loading } from './ui';
import { usePlayer, type PlayerTrack } from './player';

/** Library coordinates which sub-view is shown via lightweight local state. */
export type LibraryView =
  | { kind: 'artists' }
  | { kind: 'artist'; name: string }
  | { kind: 'album'; id: string; artistName?: string };

export default function Library({
  view,
  navigate,
}: {
  view: LibraryView;
  navigate: (v: LibraryView) => void;
}) {
  if (view.kind === 'artists') return <ArtistsList navigate={navigate} />;
  if (view.kind === 'artist') return <ArtistPage name={view.name} navigate={navigate} />;
  return <AlbumPage id={view.id} fallbackArtist={view.artistName} navigate={navigate} />;
}

/* ---------------- Artists list ---------------- */
function avatarFor(name: string) {
  return name.replace(/^the\s+/i, '').trim().slice(0, 1).toUpperCase() || '?';
}

const PAGE = 300;

function ArtistsList({ navigate }: { navigate: (v: LibraryView) => void }) {
  const [artists, setArtists] = useState<ArtistSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    let alive = true;
    api
      .artists()
      .then((d) => alive && setArtists(d))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  // reset paging whenever the search changes
  useEffect(() => {
    setLimit(PAGE);
  }, [q]);

  const filtered = useMemo(() => {
    if (!artists) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return artists;
    return artists.filter((a) => a.name.toLowerCase().includes(needle));
  }, [artists, q]);

  if (error) return <ErrorState message={error} />;

  const shown = filtered.slice(0, limit);
  const hasMore = filtered.length > shown.length;

  return (
    <>
      <h1 className="page-title">Library</h1>
      <p className="page-lede">
        {artists ? `${fmtInt(artists.length)} artists` : 'Your collection'} — pick an artist to see their
        reconstructed albums.
      </p>
      <input
        className="search"
        placeholder="Search artists…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {!artists ? (
        <Loading label="Loading artists…" />
      ) : filtered.length === 0 ? (
        <div className="empty">No artists match “{q}”.</div>
      ) : (
        <>
          <div className="list-count">
            Showing {fmtInt(shown.length)} of {fmtInt(filtered.length)}
            {q.trim() ? ' matching' : ''} artist{filtered.length === 1 ? '' : 's'}
          </div>
          <div className="panel" style={{ padding: 8 }}>
            <div className="list">
              {shown.map((a) => (
                <div
                  key={a.name}
                  className="row"
                  onClick={() => navigate({ kind: 'artist', name: a.name })}
                >
                  <div className="avatar">{avatarFor(a.name)}</div>
                  <div className="row-main">
                    <div className="row-title">{a.name}</div>
                    <div className="row-sub">
                      {fmtInt(a.trackCount)} tracks
                      {a.albumCount > 0
                        ? ` · ${fmtInt(a.albumCount)} album${a.albumCount === 1 ? '' : 's'}`
                        : ''}
                    </div>
                  </div>
                  <Icon name="chevron" className="chev" />
                </div>
              ))}
            </div>
          </div>
          {hasMore && (
            <button className="load-more" onClick={() => setLimit((n) => n + PAGE)}>
              Show {fmtInt(Math.min(PAGE, filtered.length - shown.length))} more
            </button>
          )}
        </>
      )}
    </>
  );
}

/* ---------------- Artist page (album grid) ---------------- */
function AlbumCard({
  album,
  artistName,
  navigate,
}: {
  album: AlbumSummary;
  artistName: string;
  navigate: (v: LibraryView) => void;
}) {
  return (
    <div className="album-card" onClick={() => navigate({ kind: 'album', id: album.id, artistName })}>
      <Cover albumId={album.id} title={album.title} />
      <div className="album-meta">
        <div className="album-name" title={album.title}>
          {album.title}
        </div>
        <div className="album-line">
          <span>{album.year ?? '—'}</span>
          <span>·</span>
          <span>{fmtInt(album.trackCount)} tracks</span>
        </div>
        <FlagBadges flags={album.flags} lossless={album.lossless} discCount={album.discCount} />
      </div>
    </div>
  );
}

function ArtistPage({ name, navigate }: { name: string; navigate: (v: LibraryView) => void }) {
  const [data, setData] = useState<ArtistDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api
      .artist(name)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [name]);

  return (
    <>
      <div className="breadcrumb">
        <span className="crumb" onClick={() => navigate({ kind: 'artists' })}>
          Library
        </span>
        <span className="sep">/</span>
        <span className="here">{name}</span>
      </div>

      {error ? (
        <ErrorState message={error} />
      ) : !data ? (
        <Loading label={`Loading ${name}…`} />
      ) : (
        <>
          <h1 className="page-title">{data.name}</h1>
          <p className="page-lede">
            {fmtInt(data.trackCount)} tracks ·{' '}
            {data.albumCount > 0
              ? `${fmtInt(data.albumCount)} reconstructed album${data.albumCount === 1 ? '' : 's'}`
              : 'no whole albums — tracks remain orphaned'}
          </p>
          {data.albums.length === 0 ? (
            <div className="empty">
              {data.trackCount > 0
                ? `${fmtInt(data.trackCount)} track${data.trackCount === 1 ? '' : 's'} for this artist are not yet grouped into a folder album.`
                : 'No tracks indexed for this artist.'}
            </div>
          ) : (
            <div className="album-grid">
              {data.albums.map((al) => (
                <AlbumCard key={al.id} album={al} artistName={data.name} navigate={navigate} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

/* ---------------- Add-to-profile dropdown (album → drive-sync profile) ---------------- */
function AddToProfileButton({ albumId }: { albumId: string }) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function toggle() {
    if (!open) {
      setProfiles(null);
      try {
        setProfiles(await api.profiles());
      } catch {
        setProfiles([]);
      }
    }
    setOpen((v) => !v);
  }
  function flash(name: string) {
    setOpen(false);
    setMsg(`Added to ${name}`);
    setTimeout(() => setMsg(null), 2500);
  }
  async function add(id: number, name: string) {
    await api.addToProfile({ id, albumId });
    flash(name);
  }
  async function createAndAdd() {
    const name = window.prompt('New profile name (e.g. Car, Gym, Audiobooks):')?.trim();
    if (!name) return;
    const r = await api.createProfile({ name });
    await api.addToProfile({ id: r.id, albumId });
    flash(name);
  }

  return (
    <div className="atp">
      <button className="btn ghost" onClick={() => void toggle()}>
        + Add to profile ▾
      </button>
      {msg && <span className="ok-text atp-msg">{msg}</span>}
      {open && (
        <div className="atp-menu">
          {profiles === null ? (
            <div className="atp-item muted">Loading…</div>
          ) : (
            <>
              {profiles.map((p) => (
                <div key={p.id} className="atp-item" onClick={() => void add(p.id, p.name)}>
                  <span>{p.name}</span>
                  <span className="muted">{fmtInt(p.albumCount)} albums</span>
                </div>
              ))}
              {profiles.length === 0 && <div className="atp-item muted">No profiles yet</div>}
              <div className="atp-item new" onClick={() => void createAndAdd()}>
                + New profile…
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Album page (tracks) ---------------- */
function AlbumPage({
  id,
  fallbackArtist,
  navigate,
}: {
  id: string;
  fallbackArtist?: string;
  navigate: (v: LibraryView) => void;
}) {
  const [data, setData] = useState<AlbumDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api
      .album(id)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [id]);

  const artistName = data?.artistName ?? fallbackArtist;

  const groupedByDisc = useMemo(() => {
    if (!data) return [];
    const map = new Map<number, AlbumDetail['tracks']>();
    for (const t of data.tracks) {
      const d = t.discNo ?? 1;
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(t);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [data]);

  const showDiscs = (data?.discCount ?? 1) > 1 && groupedByDisc.length > 1;

  const player = usePlayer();
  // Flat, render-ordered queue for this album + a path→index lookup so any row can start playback.
  const playlist = useMemo<PlayerTrack[]>(
    () =>
      groupedByDisc.flatMap(([, tracks]) =>
        tracks.map((t) => ({
          id: t.id,
          title: t.title,
          artistName: t.artistName || data?.artistName || '',
          path: t.path,
          durationMs: t.durationMs,
          ...(data?.id ? { albumId: data.id } : {}),
          ...(data?.title ? { albumTitle: data.title } : {}),
        })),
      ),
    [groupedByDisc, data?.artistName, data?.id, data?.title],
  );
  const indexByPath = useMemo(() => {
    const m = new Map<string, number>();
    playlist.forEach((t, i) => m.set(t.path, i));
    return m;
  }, [playlist]);

  return (
    <>
      <div className="breadcrumb">
        <span className="crumb" onClick={() => navigate({ kind: 'artists' })}>
          Library
        </span>
        <span className="sep">/</span>
        {artistName ? (
          <>
            <span className="crumb" onClick={() => navigate({ kind: 'artist', name: artistName })}>
              {artistName}
            </span>
            <span className="sep">/</span>
          </>
        ) : null}
        <span className="here">{data?.title ?? 'Album'}</span>
      </div>

      {error ? (
        <ErrorState message={error} />
      ) : !data ? (
        <Loading label="Loading album…" />
      ) : (
        <>
          <div className="album-head">
            <div style={{ width: 180, flex: 'none' }}>
              <Cover albumId={data.id} title={data.title} />
            </div>
            <div className="album-head-info">
              <h1>{data.title}</h1>
              <div className="by">
                by{' '}
                <span
                  className="link"
                  onClick={() =>
                    artistName && navigate({ kind: 'artist', name: artistName })
                  }
                >
                  {data.artistName}
                </span>
              </div>
              <div className="facts">
                {data.year && (
                  <>
                    <span>{data.year}</span>
                    <span className="dotsep">·</span>
                  </>
                )}
                <span>{fmtInt(data.tracks.length)} tracks</span>
                <span className="dotsep">·</span>
                <span>{Math.round(data.sizeBytes / 1_048_576).toLocaleString()} MB</span>
                <span className="dotsep">·</span>
                <span>{Math.round(data.confidence * 100)}% confidence</span>
              </div>
              <FlagBadges flags={data.flags} lossless={data.lossless} discCount={data.discCount} />
              <div className="album-actions">
                <button
                  className="btn primary play-btn"
                  onClick={() => playlist.length && player.playQueue(playlist, 0)}
                  disabled={playlist.length === 0}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M7 5.2v13.6a1 1 0 0 0 1.54.84l10.5-6.8a1 1 0 0 0 0-1.68L8.54 4.36A1 1 0 0 0 7 5.2z" />
                  </svg>
                  Play album
                </button>
                <AddToProfileButton albumId={data.id} />
              </div>
              {data.evidence.length > 0 && (
                <ul className="evidence">
                  {data.evidence.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="tracks">
            {groupedByDisc.map(([disc, tracks]) => (
              <div key={disc}>
                {showDiscs && <div className="disc-head">Disc {disc}</div>}
                {tracks.map((t) => {
                  const active = player.current?.path === t.path;
                  return (
                    <div
                      className={'trk' + (active ? ' active' : '')}
                      key={t.id}
                      onClick={() =>
                        active
                          ? player.toggle()
                          : player.playQueue(playlist, indexByPath.get(t.path) ?? 0)
                      }
                    >
                      <div className="no">
                        {active ? (
                          <span className={'eq' + (player.isPlaying ? ' on' : '')} aria-hidden>
                            <i />
                            <i />
                            <i />
                          </span>
                        ) : (
                          <>
                            <span className="num">{t.trackNo ?? '–'}</span>
                            <svg className="pio" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                              <path d="M7 5.2v13.6a1 1 0 0 0 1.54.84l10.5-6.8a1 1 0 0 0 0-1.68L8.54 4.36A1 1 0 0 0 7 5.2z" />
                            </svg>
                          </>
                        )}
                      </div>
                      <div>
                        <div className="tt" title={t.title}>
                          {t.title}
                        </div>
                        {t.artistName && t.artistName !== data.artistName && (
                          <div className="tsub">{t.artistName}</div>
                        )}
                      </div>
                      <div className="meta">
                        {t.lossless ? 'FLAC' : t.bitrateKbps ? `${t.bitrateKbps} kbps` : ''}
                      </div>
                      <div className="meta">{fmtDuration(t.durationMs)}</div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
