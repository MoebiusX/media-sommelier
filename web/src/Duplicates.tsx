import { useState } from 'react';
import { api, fmtBytes, fmtDuration, fmtInt, type DuplicatesResult, type DupGroup } from './api';
import { usePlayer, type PlayerTrack } from './player';

/**
 * Duplicate-track finder — the payoff of a "messy library" tool. Groups the same song ripped many
 * times (normalized title+artist within a ~10s window) and recommends a keeper (lossless > bitrate >
 * size). READ-ONLY: it surfaces them and the reclaimable space; deletion is the user's call.
 */
export default function Duplicates() {
  const [data, setData] = useState<DuplicatesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const player = usePlayer();

  async function scan() {
    setLoading(true);
    try {
      setData(await api.duplicates());
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  function play(g: DupGroup, t: DupGroup['tracks'][number]) {
    const pt: PlayerTrack = {
      id: t.id,
      title: g.title,
      artistName: g.artist,
      path: t.path,
      durationMs: t.durationMs,
      ...(t.albumId ? { albumId: t.albumId } : {}),
    };
    player.playQueue([pt], 0);
  }

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-title">
        Duplicate tracks <span className="muted">the same song ripped more than once</span>
      </div>

      {!data ? (
        <div className="rb-intro">
          <div className="muted">
            Find songs that exist multiple times across your library and how much space the extras take.
          </div>
          <button className="btn primary" onClick={() => void scan()} disabled={loading}>
            {loading ? 'Scanning…' : 'Find duplicates'}
          </button>
        </div>
      ) : data.totalGroups === 0 ? (
        <div className="muted">No duplicates found — your library is clean. ✓</div>
      ) : (
        <>
          <div className="dup-headline">
            <span>
              <b>{fmtInt(data.totalGroups)}</b> duplicated songs ·{' '}
              <b className="ok-text">{fmtBytes(data.wastedBytes)}</b> reclaimable
            </span>
            <span className="muted">keeper = best quality (lossless &gt; bitrate &gt; size)</span>
          </div>
          <div className="dup-list">
            {data.groups.map((g, i) => (
              <div className="dup-group" key={i}>
                <div className="dup-group-head" onClick={() => setOpenIdx(openIdx === i ? null : i)}>
                  <span className="dup-chev">{openIdx === i ? '▾' : '▸'}</span>
                  <span className="dup-name" title={`${g.artist} — ${g.title}`}>
                    {g.artist} — {g.title}
                  </span>
                  <span className="dup-badges">
                    <span className="badge multi">×{g.count}</span>
                    <span className="badge">{fmtBytes(g.wastedBytes)} extra</span>
                  </span>
                </div>
                {openIdx === i && (
                  <div className="dup-files">
                    {g.tracks.map((t) => (
                      <div className={'dup-file' + (t.keeper ? ' keep' : '')} key={t.id}>
                        <button className="dup-play" title="Play" onClick={() => play(g, t)}>
                          ▶
                        </button>
                        {t.keeper ? <span className="badge good">keep</span> : <span className="badge dim">extra</span>}
                        <span className="dup-fmt">
                          {t.lossless ? 'FLAC' : `${t.ext.toUpperCase()} ${t.bitrateKbps ?? '?'}k`}
                        </span>
                        <span className="dup-size">{fmtBytes(t.sizeBytes)}</span>
                        <span className="dup-dur">{fmtDuration(t.durationMs)}</span>
                        <span className="dup-path" title={t.path}>
                          {t.path}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {data.totalGroups > data.groups.length && (
            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              Showing the top {fmtInt(data.groups.length)} by reclaimable space.
            </div>
          )}
        </>
      )}
    </div>
  );
}
