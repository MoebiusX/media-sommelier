import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  fmtBytes,
  fmtInt,
  type Preset,
  type ProfileDetail,
  type ProfileSummary,
  type SyncStatus,
} from './api';
import { Cover, Loading } from './ui';

/**
 * Drive-sync profiles. A profile = a hand-picked set of albums + a target drive + a naming scheme.
 * Sync is ADDITIVE: it copies the profile's tracks to the drive (idempotent — already-present files are
 * skipped) and never deletes. Add albums from the Library's "Add to profile" control.
 */
export default function Drives({ onBrowseLibrary }: { onBrowseLibrary: () => void }) {
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);
  const [presets, setPresets] = useState<Record<string, Preset>>({});
  const [newName, setNewName] = useState('');
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const polling = useRef(false);

  const load = useCallback(async () => {
    try {
      setProfiles(await api.profiles());
    } catch {
      setProfiles([]);
    }
  }, []);

  useEffect(() => {
    void load();
    api.presets().then(setPresets).catch(() => {});
  }, [load]);

  const startSync = useCallback(
    async (id: number) => {
      if (polling.current) return;
      const r = await api.syncProfile(id);
      if (!r.ok) {
        setSync({ ...r.job, state: 'error', error: r.error ?? 'sync failed' });
        return;
      }
      polling.current = true;
      setSync(r.job);
      try {
        for (;;) {
          await new Promise((res) => setTimeout(res, 800));
          const s = await api.syncStatus();
          setSync(s);
          if (s.state === 'done' || s.state === 'error') break;
        }
      } finally {
        polling.current = false;
        void load(); // refresh sizes / last-sync
      }
    },
    [load],
  );

  async function create() {
    const name = newName.trim();
    if (!name) return;
    await api.createProfile({ name });
    setNewName('');
    void load();
  }

  return (
    <>
      <h1 className="page-title">Sync to drives</h1>
      <p className="page-lede">
        A profile is a hand-picked set of albums kept on an external drive — one for the car, one for
        audiobooks, one for the gym. Sync copies what's new and never deletes. Add albums from the{' '}
        <span className="link" onClick={onBrowseLibrary}>
          Library
        </span>
        .
      </p>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="sb-row">
          <input
            className="sb-input"
            placeholder="New profile name — e.g. Car, Audiobooks, Gym"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
          <button className="btn primary" onClick={() => void create()} disabled={!newName.trim()}>
            Create profile
          </button>
        </div>
      </div>

      {!profiles ? (
        <Loading label="Loading profiles…" />
      ) : profiles.length === 0 ? (
        <div className="empty">No profiles yet. Create one above, then add albums from the Library.</div>
      ) : (
        <div className="profile-list">
          {profiles.map((p) => (
            <ProfileCard
              key={p.id}
              summary={p}
              presets={presets}
              sync={sync?.profileId === p.id ? sync : null}
              onSync={() => void startSync(p.id)}
              syncing={!!sync && sync.state === 'running'}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ago(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function ProfileCard({
  summary,
  presets,
  sync,
  syncing,
  onSync,
  onChanged,
}: {
  summary: ProfileSummary;
  presets: Record<string, Preset>;
  sync: SyncStatus | null;
  syncing: boolean;
  onSync: () => void;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<ProfileDetail | null>(null);
  const [target, setTarget] = useState(summary.target);
  const [preset, setPreset] = useState(summary.preset);
  const [transcode, setTranscode] = useState(summary.transcodeTo === 'mp3');
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const d = await api.profile(summary.id);
      setDetail(d);
      setTarget(d.target);
      setPreset(d.preset);
      setTranscode(d.transcodeTo === 'mp3');
    } catch {
      /* ignore */
    }
  }, [summary.id]);

  useEffect(() => {
    void refresh();
  }, [refresh, summary.albumCount, summary.lastSyncAt]);

  async function saveTarget() {
    if (target.trim() === summary.target) return;
    await api.updateProfile({ id: summary.id, target: target.trim() });
    await onChanged();
  }
  async function pickTarget() {
    const r = await api.pickFolder();
    if (r.path) {
      setTarget(r.path);
      await api.updateProfile({ id: summary.id, target: r.path });
      await onChanged();
    }
  }
  async function changePreset(v: string) {
    setPreset(v);
    await api.updateProfile({ id: summary.id, preset: v });
  }
  async function changeTranscode(v: boolean) {
    setTranscode(v);
    await api.updateProfile({ id: summary.id, transcodeTo: v ? 'mp3' : 'none' });
  }
  async function removeAlbum(albumId: string) {
    await api.removeFromProfile({ id: summary.id, albumId });
    await refresh();
    await onChanged();
  }
  async function del() {
    if (!confirm(`Delete profile “${summary.name}”? (Files already on the drive are left as-is.)`)) return;
    await api.deleteProfile(summary.id);
    await onChanged();
  }

  const running = sync?.state === 'running';
  const pct = sync && sync.total > 0 ? Math.round((sync.done / sync.total) * 100) : null;
  const noTarget = !target.trim();
  const empty = summary.albumCount === 0;

  return (
    <div className="profile-card">
      <div className="profile-top">
        <div className="profile-id">
          <h3>{summary.name}</h3>
          <div className="profile-sub">
            {fmtInt(summary.albumCount)} albums · {fmtInt(summary.trackCount)} tracks ·{' '}
            {fmtBytes(summary.bytes)} · last sync {ago(summary.lastSyncAt)}
          </div>
        </div>
        <button className="icon-btn" title="Delete profile" onClick={() => void del()}>
          ✕
        </button>
      </div>

      <div className="profile-controls">
        <label className="field grow">
          <span>Target drive / folder</span>
          <div className="sb-row">
            <input
              className="sb-input"
              placeholder="e.g.  E:\   or   E:\Sommelier\Car"
              value={target}
              spellCheck={false}
              onChange={(e) => setTarget(e.target.value)}
              onBlur={() => void saveTarget()}
              disabled={running}
            />
            <button className="btn ghost" onClick={() => void pickTarget()} disabled={running}>
              Browse…
            </button>
          </div>
        </label>
        <label className="field">
          <span>Naming scheme</span>
          <select
            className="sb-input"
            value={preset}
            onChange={(e) => void changePreset(e.target.value)}
            disabled={running}
          >
            {Object.entries(presets).map(([k, p]) => (
              <option key={k} value={k}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="check end" title="Re-encode FLAC/lossless to MP3 320k so car stereos can play it">
          <input
            type="checkbox"
            checked={transcode}
            onChange={(e) => void changeTranscode(e.target.checked)}
            disabled={running}
          />
          Convert to MP3 (car)
        </label>
      </div>

      {detail && detail.riskTracks > 0 && (
        <div className={'profile-warn' + (transcode ? ' ok' : '')}>
          {transcode
            ? `♪ ${fmtInt(detail.riskTracks)} lossless/FLAC track${detail.riskTracks === 1 ? '' : 's'} will be converted to MP3 320k on sync (slower, but car-ready).`
            : `⚠ ${fmtInt(detail.riskTracks)} track${detail.riskTracks === 1 ? '' : 's'} are lossless/FLAC and may not play on car stereos. Copied as-is — tick "Convert to MP3" to fix.`}
        </div>
      )}

      <div className="profile-actions">
        <button
          className="btn primary"
          onClick={onSync}
          disabled={running || syncing || noTarget || empty}
          title={noTarget ? 'Set a target drive first' : empty ? 'Add albums first' : undefined}
        >
          {running ? 'Syncing…' : 'Sync now'}
        </button>
        <button className="btn ghost" onClick={() => setOpen((v) => !v)} disabled={empty}>
          {open ? 'Hide albums' : `Show albums (${fmtInt(summary.albumCount)})`}
        </button>
        {sync && sync.state === 'done' && sync.result && (
          <span className="ok-text">
            ✓ {fmtInt(sync.result.copied)} synced
            {sync.result.transcoded ? ` (${fmtInt(sync.result.transcoded)} converted to MP3)` : ''} · skipped{' '}
            {fmtInt(sync.result.skipped)}
            {sync.result.failed ? ` · ${sync.result.failed} failed` : ''} ({fmtBytes(sync.result.bytes)})
          </span>
        )}
        {sync && sync.state === 'error' && <span className="err-text">Sync failed: {sync.error}</span>}
      </div>

      {running && (
        <div>
          <div className="sb-line">
            <span className="spinner-sm" /> {sync!.phase || 'syncing'} {fmtInt(sync!.done)} / {fmtInt(sync!.total)} files
            <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={() => void api.cancelSync()}>
              Cancel
            </button>
          </div>
          {pct !== null && (
            <div className="sb-bar" style={{ marginTop: 8 }}>
              <div className="sb-fill" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      )}

      {open && detail && (
        <div className="profile-albums">
          {detail.albums.length === 0 ? (
            <div className="empty" style={{ padding: 24 }}>
              No albums yet — add them from the Library.
            </div>
          ) : (
            detail.albums.map((a) => (
              <div className="pa-row" key={a.id}>
                <div className="pa-cover">
                  <Cover albumId={a.id} title={a.title} />
                </div>
                <div className="pa-main">
                  <div className="pa-title" title={a.title}>
                    {a.title}
                  </div>
                  <div className="pa-sub">
                    {a.artistName}
                    {a.year ? ` · ${a.year}` : ''} · {fmtInt(a.trackCount)} tracks · {fmtBytes(a.sizeBytes)}
                    {a.lossless ? ' · FLAC' : ''}
                  </div>
                </div>
                <button className="icon-btn" title="Remove from profile" onClick={() => void removeAlbum(a.id)}>
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
