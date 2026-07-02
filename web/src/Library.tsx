import { useEffect, useMemo, useState } from 'react';
import {
  api,
  fmtDuration,
  fmtInt,
  type AlbumDetail,
  type ArtistDetail,
  type ArtistSummary,
  type BrowseAlbum,
  type ProfileSummary,
  type PlaylistSummary,
  type RefreshPreview,
  type Completeness,
} from './api';
import { Cover, ErrorState, FlagBadges, Loading, useClickOutside } from './ui';
import { usePlayer, type PlayerTrack } from './player';
import CollectionView from './collection/CollectionView';
import { albumsDescriptor, artistsDescriptor } from './collection/descriptors';

/** Library coordinates which sub-view is shown via lightweight local state. */
export type LibraryView =
  | { kind: 'artists' }
  | { kind: 'albums' }
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
  if (view.kind === 'albums') return <AlbumsBrowse navigate={navigate} />;
  if (view.kind === 'artist') return <ArtistPage name={view.name} navigate={navigate} />;
  return <AlbumPage id={view.id} fallbackArtist={view.artistName} navigate={navigate} />;
}

/** Artists | Albums switch shown atop both browse views. */
function LibraryTabs({ active, navigate }: { active: 'artists' | 'albums'; navigate: (v: LibraryView) => void }) {
  return (
    <div className="lib-tabs">
      <button className={active === 'artists' ? 'on' : ''} onClick={() => navigate({ kind: 'artists' })}>
        Artists
      </button>
      <button className={active === 'albums' ? 'on' : ''} onClick={() => navigate({ kind: 'albums' })}>
        Albums
      </button>
    </div>
  );
}

/* ---------------- Albums browse (all albums) ---------------- */
function AlbumsBrowse({ navigate }: { navigate: (v: LibraryView) => void }) {
  const [albums, setAlbums] = useState<BrowseAlbum[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .allAlbums()
      .then((d) => alive && setAlbums(d))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  const descriptor = useMemo(
    () => albumsDescriptor(navigate, { viewKey: 'albums', hasArtist: true, hasSize: true }),
    [navigate],
  );

  return (
    <>
      <LibraryTabs active="albums" navigate={navigate} />
      <h1 className="page-title">Albums</h1>
      <p className="page-lede">{albums ? `${fmtInt(albums.length)} reconstructed albums` : 'Your collection'}</p>
      {error ? (
        <ErrorState message={error} />
      ) : !albums ? (
        <Loading label="Loading albums…" />
      ) : (
        <CollectionView descriptor={descriptor} items={albums} pageSize={120} emptyText={() => 'No albums match.'} />
      )}
    </>
  );
}

/* ---------------- Artists list ---------------- */
function ArtistsList({ navigate }: { navigate: (v: LibraryView) => void }) {
  const [artists, setArtists] = useState<ArtistSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const descriptor = useMemo(() => artistsDescriptor(navigate), [navigate]);

  return (
    <>
      <LibraryTabs active="artists" navigate={navigate} />
      <h1 className="page-title">Library</h1>
      <p className="page-lede">
        {artists ? `${fmtInt(artists.length)} artists` : 'Your collection'} — pick an artist to see their
        reconstructed albums.
      </p>
      {error ? (
        <ErrorState message={error} />
      ) : !artists ? (
        <Loading label="Loading artists…" />
      ) : (
        <CollectionView
          descriptor={descriptor}
          items={artists}
          pageSize={300}
          emptyText={(q) => (q ? `No artists match “${q}”.` : 'No artists indexed.')}
        />
      )}
    </>
  );
}

/* ---------------- Artist page (their albums) ---------------- */
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

  const descriptor = useMemo(
    () => albumsDescriptor(navigate, { viewKey: `artist:${name}`, fallbackArtist: name, hasArtist: false, hasSize: false }),
    [navigate, name],
  );

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
            <CollectionView descriptor={descriptor} items={data.albums} pageSize={120} emptyText={() => 'No albums match.'} />
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
  const ref = useClickOutside<HTMLDivElement>(open, () => setOpen(false));

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
    <div className="atp" ref={ref}>
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

/* ---------------- Add-to-playlist dropdown ---------------- */
function AddToPlaylistButton({ albumId, trackPath, compact }: { albumId?: string; trackPath?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<PlaylistSummary[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const payload = albumId ? { albumId } : trackPath ? { trackPath } : {};
  const ref = useClickOutside<HTMLDivElement>(open, () => setOpen(false));

  async function toggle() {
    if (!open) {
      setLists(null);
      try {
        setLists(await api.playlists());
      } catch {
        setLists([]);
      }
    }
    setOpen((v) => !v);
  }
  function flash(name: string) {
    setOpen(false);
    setMsg(`Added to ${name}`);
    setTimeout(() => setMsg(null), 2200);
  }
  async function add(id: number, name: string) {
    await api.addToPlaylist({ id, ...payload });
    flash(name);
  }
  async function createAndAdd() {
    const name = window.prompt('New playlist name:')?.trim();
    if (!name) return;
    const r = await api.createPlaylist(name);
    await api.addToPlaylist({ id: r.id, ...payload });
    flash(name);
  }

  return (
    <div className="atp" ref={ref}>
      <button
        className={compact ? 'icon-btn pl-add' : 'btn ghost'}
        onClick={(e) => {
          e.stopPropagation();
          void toggle();
        }}
        title="Add to playlist"
      >
        {compact ? '＋' : '+ Add to playlist ▾'}
      </button>
      {msg && <span className="ok-text atp-msg">{msg}</span>}
      {open && (
        <div className="atp-menu" onClick={(e) => e.stopPropagation()}>
          {lists === null ? (
            <div className="atp-item muted">Loading…</div>
          ) : (
            <>
              {lists.map((p) => (
                <div key={p.id} className="atp-item" onClick={() => void add(p.id, p.name)}>
                  <span>{p.name}</span>
                  <span className="muted">{fmtInt(p.trackCount)}</span>
                </div>
              ))}
              {lists.length === 0 && <div className="atp-item muted">No playlists yet</div>}
              <div className="atp-item new" onClick={() => void createAndAdd()}>
                + New playlist…
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Refresh metadata/cover (MusicBrainz + Cover Art Archive) ---------------- */
function RefreshPanel({
  album,
  onClose,
  onApplied,
}: {
  album: AlbumDetail;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [state, setState] = useState<'loading' | 'matched' | 'nomatch' | 'applying'>('loading');
  const [preview, setPreview] = useState<RefreshPreview | null>(null);
  const [applyTitle, setApplyTitle] = useState(true);
  const [applyYear, setApplyYear] = useState(true);
  const [applyCover, setApplyCover] = useState(true);

  useEffect(() => {
    let alive = true;
    api
      .refreshAlbum(album.id)
      .then((r) => {
        if (!alive) return;
        if (r.matched && r.match) {
          setPreview(r);
          setState('matched');
        } else {
          setState('nomatch');
        }
      })
      .catch(() => alive && setState('nomatch'));
    return () => {
      alive = false;
    };
  }, [album.id]);

  const m = preview?.match;
  const titleChanges = !!m && m.album !== album.title;
  const yearChanges = !!m && m.year != null && m.year !== album.year;

  async function apply() {
    if (!m) return;
    setState('applying');
    await api.applyRefresh({
      albumId: album.id,
      ...(applyTitle && titleChanges ? { title: m.album } : {}),
      ...(applyYear && m.year != null ? { year: m.year } : {}),
      cover: applyCover && preview!.coverFetched,
      mbid: m.mbid,
    });
    onApplied();
  }
  async function skip() {
    await api.cancelRefresh(album.id).catch(() => {});
    onClose();
  }

  return (
    <div className="refresh-panel">
      {state === 'loading' && (
        <div className="sb-line">
          <span className="spinner-sm" /> Searching MusicBrainz…
        </div>
      )}
      {state === 'nomatch' && (
        <div className="refresh-nomatch">
          <span>No confident MusicBrainz match for this album. Nothing changed.</span>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      )}
      {(state === 'matched' || state === 'applying') && m && (
        <>
          <div className="refresh-head">
            <span className="refresh-title">
              MusicBrainz match <span className="badge good">{Math.round(m.score * 100)}%</span>
            </span>
            <span className="muted">{m.artist}</span>
          </div>
          <div className="refresh-body">
            {preview!.coverFetched && (
              <div className="refresh-covers">
                <div className="rc">
                  <Cover albumId={album.id} title={album.title} />
                  <span>current</span>
                </div>
                <span className="rc-arrow">→</span>
                <div className="rc">
                  <div className="cover">
                    <img src={api.pendingCoverUrl(album.id)} alt="" />
                  </div>
                  <span>Cover Art Archive</span>
                </div>
              </div>
            )}
            <div className="refresh-fields">
              {titleChanges && (
                <label className="refresh-field">
                  <input type="checkbox" checked={applyTitle} onChange={(e) => setApplyTitle(e.target.checked)} />
                  <span>
                    Title <span className="rf-from">{album.title}</span> →{' '}
                    <span className="rf-to">{m.album}</span>
                  </span>
                </label>
              )}
              {yearChanges && (
                <label className="refresh-field">
                  <input type="checkbox" checked={applyYear} onChange={(e) => setApplyYear(e.target.checked)} />
                  <span>
                    Year <span className="rf-from">{album.year ?? '—'}</span> →{' '}
                    <span className="rf-to">{m.year}</span>
                  </span>
                </label>
              )}
              {preview!.coverFetched && (
                <label className="refresh-field">
                  <input type="checkbox" checked={applyCover} onChange={(e) => setApplyCover(e.target.checked)} />
                  <span>Use the fetched cover art</span>
                </label>
              )}
              {!titleChanges && !yearChanges && !preview!.coverFetched && (
                <div className="muted">Matched, but nothing new to apply (already up to date).</div>
              )}
            </div>
          </div>
          <div className="refresh-actions">
            <button
              className="btn primary"
              onClick={() => void apply()}
              disabled={state === 'applying' || (!titleChanges && !yearChanges && !preview!.coverFetched)}
            >
              {state === 'applying' ? 'Applying…' : 'Apply'}
            </button>
            <button className="btn ghost" onClick={() => void skip()} disabled={state === 'applying'}>
              Skip
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- Album completeness (vs MusicBrainz tracklist) ---------------- */
function CompletenessPanel({ albumId, onClose }: { albumId: string; onClose: () => void }) {
  const [data, setData] = useState<Completeness | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .checkCompleteness(albumId)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData({ ok: false, matched: false }));
    return () => {
      alive = false;
    };
  }, [albumId]);

  if (!data) {
    return (
      <div className="refresh-panel">
        <div className="sb-line">
          <span className="spinner-sm" /> Checking against MusicBrainz…
        </div>
      </div>
    );
  }
  const complete = data.matched && (data.have ?? 0) >= (data.expected ?? 0);
  const missingCount = (data.expected ?? 0) - (data.have ?? 0);
  const missing = data.missing ?? [];
  return (
    <div className="refresh-panel">
      {!data.matched ? (
        <div className="refresh-nomatch">
          <span>No MusicBrainz match — can't check completeness.</span>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      ) : complete ? (
        <div className="refresh-nomatch">
          <span>
            <b className="ok-text">✓ Looks complete</b> — {fmtInt(data.have!)} of {fmtInt(data.expected!)} tracks
            match “{data.mbAlbum}”.
          </span>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
        <>
          <div className="refresh-head">
            <span className="refresh-title">
              Missing <b className="warn-text">{fmtInt(missingCount)}</b> of {fmtInt(data.expected!)} tracks{' '}
              <span className="muted">vs “{data.mbAlbum}”</span>
            </span>
          </div>
          <ul className="cmpl-missing">
            {(showAll ? missing : missing.slice(0, 8)).map((m, i) => (
              <li key={i}>
                {m.disc > 1 ? `${m.disc}-` : ''}
                {m.position}. {m.title}
              </li>
            ))}
          </ul>
          <div className="refresh-actions">
            {missing.length > 8 && !showAll && (
              <button className="btn ghost" onClick={() => setShowAll(true)}>
                Show all {fmtInt(missing.length)}
              </button>
            )}
            <button className="btn ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </>
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
  const [reloadKey, setReloadKey] = useState(0);
  const [coverVersion, setCoverVersion] = useState(0);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [completenessOpen, setCompletenessOpen] = useState(false);

  // Clear to the loading state only when navigating to a different album (not on a refresh re-fetch).
  useEffect(() => {
    setData(null);
    setRefreshOpen(false);
    setCompletenessOpen(false);
  }, [id]);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .album(id)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [id, reloadKey]);

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
              <Cover albumId={data.id} title={data.title} version={coverVersion} />
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
                <AddToPlaylistButton albumId={data.id} />
                <AddToProfileButton albumId={data.id} />
                <button
                  className="btn ghost"
                  onClick={() => setRefreshOpen((v) => !v)}
                  title="Fetch canonical metadata + cover art from MusicBrainz"
                >
                  ⟲ Refresh
                </button>
                <button
                  className="btn ghost"
                  onClick={() => setCompletenessOpen((v) => !v)}
                  title="Check this album against its MusicBrainz tracklist for missing tracks"
                >
                  ✓ Completeness
                </button>
              </div>
              {refreshOpen && (
                <RefreshPanel
                  album={data}
                  onClose={() => setRefreshOpen(false)}
                  onApplied={() => {
                    setRefreshOpen(false);
                    setCoverVersion(Date.now());
                    setReloadKey((k) => k + 1);
                  }}
                />
              )}
              {completenessOpen && (
                <CompletenessPanel albumId={data.id} onClose={() => setCompletenessOpen(false)} />
              )}
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
                      <AddToPlaylistButton trackPath={t.path} compact />
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
