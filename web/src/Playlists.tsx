import { useCallback, useEffect, useState } from 'react';
import {
  api,
  fmtDuration,
  fmtInt,
  type PlaylistDetail,
  type PlaylistSummary,
  type PlaylistTrack,
  type SmartCondition,
  type SmartRules,
} from './api';
import { usePlayer, type PlayerTrack } from './player';
import { Loading } from './ui';

const FIELDS: Array<{ v: string; label: string }> = [
  { v: 'genre', label: 'Genre' },
  { v: 'artist', label: 'Artist' },
  { v: 'album', label: 'Album' },
  { v: 'title', label: 'Title' },
  { v: 'year', label: 'Year' },
  { v: 'format', label: 'Format' },
  { v: 'lossless', label: 'Lossless' },
];
const blankCond = (): SmartCondition => ({ field: 'genre', op: 'contains', value: '' });

/** Rule builder for smart playlists — match all/any of N conditions, sort + limit. */
function RuleBuilder({
  initialName,
  initialRules,
  onSave,
  onCancel,
}: {
  initialName?: string;
  initialRules?: SmartRules;
  onSave: (name: string, rules: SmartRules) => void;
  onCancel: () => void;
}) {
  const creating = initialName === undefined;
  const [name, setName] = useState('');
  const [match, setMatch] = useState<'all' | 'any'>(initialRules?.match ?? 'all');
  const [conds, setConds] = useState<SmartCondition[]>(initialRules?.conditions?.length ? initialRules.conditions : [blankCond()]);
  const [sort, setSort] = useState(initialRules?.sort ?? 'artist');
  const [limit, setLimit] = useState(String(initialRules?.limit ?? 100));

  const setCond = (i: number, patch: Partial<SmartCondition>) => setConds((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  function valueInput(c: SmartCondition, i: number) {
    if (c.field === 'lossless')
      return (
        <select className="sb-input" value={c.value || 'true'} onChange={(e) => setCond(i, { value: e.target.value })}>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    if (c.field === 'format')
      return (
        <select className="sb-input" value={c.value || 'mp3'} onChange={(e) => setCond(i, { value: e.target.value })}>
          {['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'wma'].map((f) => (
            <option key={f} value={f}>
              {f.toUpperCase()}
            </option>
          ))}
        </select>
      );
    if (c.field === 'year')
      return <input className="sb-input" type="number" placeholder="1990" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} />;
    return <input className="sb-input" placeholder="contains…" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} />;
  }
  function save() {
    const n = creating ? name.trim() : initialName!;
    if (creating && !n) return;
    // The Lossless/Format value <select>s show a default option ("Yes" / "MP3") even when the underlying
    // condition value is still '' (blank on creation, or field just switched) — normalize to what's
    // actually displayed so the saved rule always matches what the user sees.
    const normalized = conds.map((c) =>
      c.field === 'lossless' && !c.value
        ? { ...c, value: 'true' }
        : c.field === 'format' && !c.value
          ? { ...c, value: 'mp3' }
          : c,
    );
    onSave(n, {
      match,
      conditions: normalized.filter((c) => c.field === 'lossless' || c.field === 'format' || c.value.trim()),
      sort,
      limit: Number(limit) || 100,
    });
  }
  return (
    <div className="panel rule-builder" style={{ marginBottom: 16 }}>
      {creating && (
        <input className="sb-input" placeholder="Smart playlist name" value={name} onChange={(e) => setName(e.target.value)} style={{ marginBottom: 12 }} />
      )}
      <div className="rb-match">
        Match{' '}
        <select className="sb-input inline" value={match} onChange={(e) => setMatch(e.target.value as 'all' | 'any')}>
          <option value="all">all</option>
          <option value="any">any</option>
        </select>{' '}
        of:
      </div>
      {conds.map((c, i) => (
        <div className="rb-cond" key={i}>
          <select className="sb-input" value={c.field} onChange={(e) => setCond(i, { field: e.target.value, op: e.target.value === 'year' ? 'is' : 'contains', value: '' })}>
            {FIELDS.map((f) => (
              <option key={f.v} value={f.v}>
                {f.label}
              </option>
            ))}
          </select>
          {c.field === 'year' && (
            <select className="sb-input" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} style={{ flex: 'none', width: 70 }}>
              <option value="is">is</option>
              <option value="gte">≥</option>
              <option value="lte">≤</option>
            </select>
          )}
          {valueInput(c, i)}
          <button className="icon-btn" onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))} disabled={conds.length <= 1}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn ghost" onClick={() => setConds((cs) => [...cs, blankCond()])}>
        + Add rule
      </button>
      <div className="rb-foot">
        <label>
          Sort{' '}
          <select className="sb-input inline" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="artist">Artist</option>
            <option value="year">Newest</option>
            <option value="title">Title</option>
            <option value="random">Random</option>
          </select>
        </label>
        <label>
          Limit <input className="sb-input inline" type="number" value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 80 }} />
        </label>
        <div className="rb-actions">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={creating && !name.trim()}>
            {creating ? 'Create' : 'Save rules'}
          </button>
        </div>
      </div>
    </div>
  );
}

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
  const [smartOpen, setSmartOpen] = useState(false);

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
  async function createSmart(n: string, rules: SmartRules) {
    await api.createPlaylist(n, rules);
    setSmartOpen(false);
    void load();
  }

  return (
    <>
      <h1 className="page-title">Playlists</h1>
      <p className="page-lede">
        Build listening sets by hand, or a <b>smart playlist</b> that fills itself from rules (genre,
        format, year…) and stays up to date.
      </p>
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
          <button className="btn ghost" onClick={() => setSmartOpen((v) => !v)}>
            ✦ Smart playlist
          </button>
        </div>
      </div>
      {smartOpen && <RuleBuilder onSave={(n, r) => void createSmart(n, r)} onCancel={() => setSmartOpen(false)} />}
      {!items ? (
        <Loading label="Loading playlists…" />
      ) : items.length === 0 ? (
        <div className="empty">No playlists yet. Create one above, then add tracks from an album or search.</div>
      ) : (
        <div className="panel" style={{ padding: 8 }}>
          <div className="list">
            {items.map((p) => (
              <div className="row" key={p.id} onClick={() => onOpen(p.id)}>
                <div className="avatar">{p.smart ? '✦' : '♪'}</div>
                <div className="row-main">
                  <div className="row-title">{p.name}</div>
                  <div className="row-sub">
                    {p.smart ? 'Smart · ' : ''}
                    {fmtInt(p.trackCount)} tracks
                  </div>
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
  const [editRules, setEditRules] = useState(false);
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
              {data.smart && (
                <button className="btn ghost" onClick={() => setEditRules(true)}>
                  Edit rules
                </button>
              )}
              <button className="btn ghost" onClick={() => void del()}>
                Delete
              </button>
            </div>
          </div>
          <p className="page-lede">
            {data.smart ? '✦ Smart · ' : ''}
            {fmtInt(data.tracks.length)} tracks
          </p>
          {editRules && data.rules && (
            <RuleBuilder
              initialName={data.name}
              initialRules={data.rules}
              onSave={async (_n, rules) => {
                await api.updatePlaylistRules(id, rules);
                setEditRules(false);
                await load();
              }}
              onCancel={() => setEditRules(false)}
            />
          )}
          {data.tracks.length === 0 ? (
            <div className="empty">{data.smart ? 'No tracks match these rules yet.' : 'Empty. Add tracks from an album page or the ⌘K search.'}</div>
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
                    {data.smart ? (
                      <span />
                    ) : (
                      <button className="icon-btn pl-remove" title="Remove from playlist" onClick={() => void remove(t.path)}>
                        ✕
                      </button>
                    )}
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
