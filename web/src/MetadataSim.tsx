// "Reconstruct by metadata" — group the indexed catalog by embedded album tags (not folders), surface
// the "integrated" albums folders had scattered, and (optionally) REORGANIZE the library by tags: copy
// into a clean Artist/Album tree. Originals are never touched (executePlan copies + guards dest⊄source).
import { useEffect, useRef, useState } from 'react';
import { api, fmtInt, type MetadataReconResult, type OrganizeStatus, type PlanSummary } from './api';

export default function MetadataSim() {
  // ---- simulate ----
  const [data, setData] = useState<MetadataReconResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setErr(null);
    try {
      setData(await api.reconstructMetadata());
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }

  // ---- reorganize ----
  const [dest, setDest] = useState<string>(
    () => localStorage.getItem('somm.metaDest') ?? 'D:\\Organized-by-tags',
  );
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [planning, setPlanning] = useState(false);
  const [job, setJob] = useState<OrganizeStatus | null>(null);
  const [orgErr, setOrgErr] = useState<string | null>(null);
  const pollRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    localStorage.setItem('somm.metaDest', dest);
  }, [dest]);
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  async function pickDest() {
    const r = await api.pickFolder();
    if (r.path) setDest(r.path);
  }

  async function preview() {
    setOrgErr(null);
    setJob(null);
    setPlan(null);
    setPlanning(true);
    try {
      setPlan(await api.organizeMetadataPlan({ dest, preset: 'artist-album' }));
    } catch (e) {
      setOrgErr(String((e as Error).message ?? e));
    } finally {
      setPlanning(false);
    }
  }

  function startPoll() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      api
        .organizeStatus()
        .then((s) => {
          setJob(s);
          if (s.state !== 'running' && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = undefined;
          }
        })
        .catch(() => {});
    }, 1000);
  }

  async function organize() {
    setOrgErr(null);
    setPlan(null);
    try {
      const r = await api.startOrganizeMetadata({ dest, preset: 'artist-album' });
      setJob(r.job);
      startPoll();
    } catch (e) {
      setOrgErr(String((e as Error).message ?? e));
    }
  }

  const running = job?.state === 'running';
  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : null;
  const s = data?.stats;

  return (
    <>
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-title">
          Reconstruct by metadata <span className="muted">group your indexed library by embedded album tags</span>
        </div>
        <p className="page-lede" style={{ margin: '0 0 14px' }}>
          Folder reconstruction groups by where files <em>live</em>. This groups by what their tags <em>say</em> —
          pulling songs that share an album tag into one album, even when they’re scattered across folders.
        </p>
        <button className="btn primary" onClick={() => void run()} disabled={loading}>
          {loading ? 'Analyzing catalog…' : 'Simulate metadata grouping'}
        </button>

        {err && <div className="err-text" style={{ marginTop: 12 }}>{err}</div>}

        {data && s && (
          <div style={{ marginTop: 18 }}>
            {s.albums === 0 ? (
              <div className="empty">No indexed tracks yet — scan a library first (Library tab), then re-run.</div>
            ) : (
              <>
                <div className="scheme-verdict">
                  <b>
                    Metadata grouping finds {fmtInt(s.albums)} albums — {fmtInt(s.integratedAlbums)} of them integrate{' '}
                    {fmtInt(s.integratedTracks)} tracks scattered across multiple folders.
                  </b>{' '}
                  <span className="muted">Folder reconstruction produced {fmtInt(data.folderAlbums)} albums.</span>
                </div>

                <div className="chips" style={{ marginTop: 12 }}>
                  <span className="chip"><span className="fmt">Albums</span><span className="ct">{fmtInt(s.albums)}</span></span>
                  <span className="chip"><span className="fmt">Multi-track</span><span className="ct">{fmtInt(s.multiTrackAlbums)}</span></span>
                  <span className="chip"><span className="fmt">Integrated</span><span className="ct">{fmtInt(s.integratedAlbums)}</span></span>
                  <span className="chip"><span className="fmt">Tracks recovered</span><span className="ct">{fmtInt(s.integratedTracks)}</span></span>
                  <span className="chip"><span className="fmt">Untagged</span><span className="ct">{fmtInt(s.untaggedTracks)}</span></span>
                </div>

                {data.integrated.length > 0 ? (
                  <>
                    <div className="list-count" style={{ marginTop: 16 }}>
                      {data.integratedTotal > data.integrated.length
                        ? `Top ${fmtInt(data.integrated.length)} of ${fmtInt(data.integratedTotal)} integrated albums`
                        : `${fmtInt(data.integratedTotal)} integrated albums`}{' '}
                      — each pulled from multiple folders
                    </div>
                    <div className="meta-albums">
                      {data.integrated.map((a) => (
                        <div className="meta-album" key={a.key}>
                          <div className="meta-album-head">
                            <div className="meta-album-name" title={a.album}>{a.album}</div>
                            <div className="meta-album-by">
                              {a.artist}
                              {a.year ? ` · ${a.year}` : ''}
                            </div>
                          </div>
                          <div className="meta-album-facts">
                            <span>{fmtInt(a.trackCount)} tracks</span>
                            {a.discCount > 1 && (
                              <>
                                <span className="dotsep">·</span>
                                <span>{a.discCount} discs</span>
                              </>
                            )}
                            <span className="dotsep">·</span>
                            <span className="meta-from">from {a.folderCount} folders</span>
                          </div>
                          <div className="meta-folders">
                            {a.folders.map((f, i) => (
                              <span className="meta-folder" key={i} title={f}>{f || '—'}</span>
                            ))}
                            {a.folderCount > a.folders.length && (
                              <span className="meta-folder more">+{a.folderCount - a.folders.length} more</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="empty" style={{ marginTop: 14 }}>
                    No cross-folder albums found — your tags and folders already agree.
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-title">
          Reorganize by metadata <span className="muted">copy into a clean tree, grouped by tags</span>
        </div>
        <p className="page-lede" style={{ margin: '0 0 14px' }}>
          Copy every tagged track into a fresh <code>Artist / Album / NN - Title</code> tree based on its tags —
          integrated albums included. Originals are never touched; each copy is hash-verified.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            className="search"
            style={{ margin: 0, flex: 1 }}
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            placeholder="Destination folder (a new, empty folder)"
          />
          <button className="btn ghost" onClick={() => void pickDest()}>Browse…</button>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => void preview()} disabled={planning || running || !dest.trim()}>
            {planning ? 'Planning…' : 'Preview plan'}
          </button>
          <button className="btn primary" onClick={() => void organize()} disabled={running || !dest.trim()}>
            Organize into this folder
          </button>
          {running && (
            <button className="btn danger" onClick={() => void api.cancelOrganize().catch(() => {})}>
              Cancel
            </button>
          )}
        </div>

        {orgErr && <div className="err-text" style={{ marginTop: 12 }}>{orgErr}</div>}

        {plan && !job && (
          <div style={{ marginTop: 14 }}>
            <div className="facts">
              <span>{fmtInt(plan.actions)} files to copy</span>
              <span className="dotsep">·</span>
              <span>{plan.collisions} collisions</span>
              <span className="dotsep">·</span>
              <span>{plan.skipped} skipped</span>
            </div>
            <pre className="tree">
              {plan.sample.join('\n')}
              {plan.actions > plan.sample.length ? `\n… and ${fmtInt(plan.actions - plan.sample.length)} more` : ''}
            </pre>
          </div>
        )}

        {job && (
          <div style={{ marginTop: 14 }}>
            {job.state === 'running' && (
              <div>
                <div className="sb-line">
                  <span className="spinner-sm" /> {job.phase} — {fmtInt(job.done)} / {fmtInt(job.total)} files
                </div>
                {pct !== null && (
                  <div className="sb-bar" style={{ marginTop: 10 }}>
                    <div className="sb-fill" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            )}
            {job.state === 'done' && job.result && (
              <div className="ok-text" style={{ fontSize: 15, fontWeight: 600 }}>
                ✓ Organized {fmtInt(job.result.copied)} files into <code>{job.result.dest}</code>
                {job.result.failed ? <span className="err-text"> · {job.result.failed} failed</span> : null}
              </div>
            )}
            {job.state === 'cancelled' && <div className="muted">Cancelled. Nothing further was copied.</div>}
            {job.state === 'error' && <div className="err-text">Failed: {job.error}</div>}
          </div>
        )}
      </div>
    </>
  );
}
