import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtInt, type RefreshBatchJob } from './api';

/**
 * Library-wide cover/metadata refresh. Sweeps albums (missing art by default) against MusicBrainz +
 * Cover Art Archive, then shows a review queue — you pick which proposals to apply (preview-then-confirm).
 * The sweep is rate-limited (~1 album/sec) and cancellable; cancelling keeps whatever it gathered.
 */
export default function RefreshBatch() {
  const [cand, setCand] = useState<{ missing: number; attempted: number; total: number } | null>(null);
  const [job, setJob] = useState<RefreshBatchJob | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applied, setApplied] = useState<number | null>(null);
  const polling = useRef(false);

  const loadCandidates = useCallback(async () => {
    try {
      setCand(await api.refreshCandidates());
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

  const poll = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 1200));
        const s = await api.refreshBatchStatus();
        setJob(s);
        if (s.state === 'done' || s.state === 'error') {
          // pre-select every proposal for one-click apply-all
          setSelected(new Set(s.proposals.map((p) => p.albumId)));
          break;
        }
      }
    } finally {
      polling.current = false;
    }
  }, []);

  async function start(force = false) {
    setApplied(null);
    setJob(null);
    const r = await api.startRefreshBatch({ onlyMissing: true, force });
    setJob(r.job);
    void poll();
  }
  async function cancel() {
    await api.cancelRefreshBatch().catch(() => {});
  }
  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  async function applySelected() {
    if (!job) return;
    const items = job.proposals
      .filter((p) => selected.has(p.albumId))
      .map((p) => ({
        albumId: p.albumId,
        ...(p.match.year != null ? { year: p.match.year } : {}),
        cover: p.coverFetched,
        mbid: p.match.mbid,
      }));
    const r = await api.applyRefreshBatch(items);
    setApplied(r.applied);
    setJob(null);
    setSelected(new Set());
    void loadCandidates();
  }

  const running = job?.state === 'running';
  const reviewing = (job?.state === 'done' || job?.state === 'error') && job.proposals.length > 0;
  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-title">
        Cover art & metadata{' '}
        <span className="muted">refresh from MusicBrainz + Cover Art Archive</span>
      </div>

      {!running && !reviewing && (
        <div className="rb-intro">
          <div>
            {cand ? (
              <>
                <b>{fmtInt(cand.missing)}</b> of {fmtInt(cand.total)} albums have no cover art
                {cand.attempted > 0 ? <> · {fmtInt(cand.attempted)} already checked</> : ''}.{' '}
                {applied != null && <span className="ok-text">✓ applied {fmtInt(applied)} just now.</span>}
              </>
            ) : (
              'Checking your library…'
            )}
          </div>
          <div className="rb-intro-actions">
            {cand && cand.attempted > 0 && (
              <button
                className="btn ghost"
                onClick={() => void start(true)}
                title="Ignore the cache and look every album up again"
              >
                Re-check all
              </button>
            )}
            <button className="btn primary" onClick={() => void start(false)} disabled={!cand || cand.missing === 0}>
              {cand && cand.attempted > 0 ? 'Resume' : 'Find missing covers'}
            </button>
          </div>
        </div>
      )}

      {running && (
        <div>
          <div className="sb-line">
            <span className="spinner-sm" /> Searching MusicBrainz — {fmtInt(job!.done)} / {fmtInt(job!.total)}{' '}
            albums · {fmtInt(job!.proposals.length)} found
            <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={() => void cancel()}>
              Stop & review
            </button>
          </div>
          <div className="sb-bar" style={{ marginTop: 10 }}>
            <div className="sb-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            Rate-limited to ~1 album/sec (MusicBrainz ToS). You can stop any time and review what's found.
          </div>
        </div>
      )}

      {reviewing && job && (
        <div>
          <div className="rb-review-head">
            <span>
              <b>{fmtInt(job.proposals.length)}</b> proposals · {fmtInt(selected.size)} selected
              {job.phase === 'cancelled' ? ' · stopped early' : ''}
            </span>
            <div className="rb-review-actions">
              <button
                className="btn ghost"
                onClick={() =>
                  setSelected(
                    selected.size === job.proposals.length ? new Set() : new Set(job.proposals.map((p) => p.albumId)),
                  )
                }
              >
                {selected.size === job.proposals.length ? 'Deselect all' : 'Select all'}
              </button>
              <button className="btn primary" onClick={() => void applySelected()} disabled={selected.size === 0}>
                Apply {fmtInt(selected.size)}
              </button>
            </div>
          </div>
          <div className="rb-list">
            {job.proposals.map((p) => {
              const yearChange = p.match.year != null && p.match.year !== p.year;
              return (
                <label className={'rb-row' + (selected.has(p.albumId) ? ' on' : '')} key={p.albumId}>
                  <input type="checkbox" checked={selected.has(p.albumId)} onChange={() => toggle(p.albumId)} />
                  <div className="rb-cover">
                    {p.coverFetched ? (
                      <img src={api.pendingCoverUrl(p.albumId)} alt="" />
                    ) : (
                      <div className="rb-nocover">♪</div>
                    )}
                  </div>
                  <div className="rb-main">
                    <div className="rb-title" title={p.title}>
                      {p.title}
                    </div>
                    <div className="rb-sub">
                      {p.artistName} · match {Math.round(p.match.score * 100)}%
                    </div>
                  </div>
                  <div className="rb-tags">
                    {p.coverFetched && <span className="badge good">cover</span>}
                    {yearChange && (
                      <span className="badge multi">
                        {p.year ?? '—'}→{p.match.year}
                      </span>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {(job?.state === 'done' || job?.state === 'error') && job.proposals.length === 0 && (
        <div className="rb-intro">
          <div className="muted">No new covers or metadata found for the albums checked.</div>
          <button className="btn ghost" onClick={() => setJob(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
