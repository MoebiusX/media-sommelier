import { useEffect, useState } from 'react';
import { api, type OrganizeStatus, type PlanSummary, type Preset, type SimulateResult } from './api';
import MetadataSim from './MetadataSim';

/**
 * The organizer — the whole point of the app. Pick the messy source folder + a destination + a naming
 * scheme, optionally Preview the plan (dry run), then Organize: the server spawns a CHILD PROCESS that
 * copies the reconstructed library into a clean new tree, streaming progress here. Originals are never
 * modified (the engine refuses a destination inside the source and never overwrites). You can Cancel a
 * run, and "Browse the result" indexes the output so you can see it.
 */
export default function Organize({
  source,
  setSource,
  onOpenResult,
}: {
  source: string;
  setSource: (s: string) => void;
  onOpenResult: (dest: string) => void;
}) {
  const [dest, setDest] = useState<string>(() => localStorage.getItem('somm.dest') ?? 'D:\\Organized');
  const [presets, setPresets] = useState<Record<string, Preset>>({});
  const [preset, setPreset] = useState('artist-year-album');
  const [writeTags, setWriteTags] = useState(false);
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [planning, setPlanning] = useState(false);
  const [sim, setSim] = useState<SimulateResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [job, setJob] = useState<OrganizeStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.presets().then(setPresets).catch(() => {});
  }, []);
  useEffect(() => {
    localStorage.setItem('somm.dest', dest);
  }, [dest]);

  const running = job?.state === 'running';
  const noSource = !source.trim();
  const noDest = !dest.trim();
  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : null;

  async function pickSource() {
    const r = await api.pickFolder();
    if (r.path) setSource(r.path);
  }
  async function pickDest() {
    const r = await api.pickFolder();
    if (r.path) setDest(r.path);
  }

  async function preview() {
    setErr(null);
    setSim(null);
    setPlan(null);
    setJob(null);
    setPlanning(true);
    try {
      setPlan(await api.organizePlan({ source, dest, preset }));
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setPlanning(false);
    }
  }

  // Score every naming scheme in one walk so you can pick the least-fragmenting one without trial runs.
  async function simulate() {
    setErr(null);
    setSim(null);
    setPlan(null);
    setJob(null);
    setSimulating(true);
    try {
      setSim(await api.simulateSchemes(source));
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSimulating(false);
    }
  }

  async function run() {
    setErr(null);
    setSim(null);
    setPlan(null);
    try {
      await api.startOrganize({ source, dest, preset, writeTags });
      setJob({ state: 'running', phase: 'starting', done: 0, total: 0 });
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((r) => setTimeout(r, 1000));
        const s = await api.organizeStatus();
        setJob(s);
        if (s.state === 'done' || s.state === 'error' || s.state === 'cancelled') break;
      }
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  async function cancel() {
    try {
      await api.cancelOrganize();
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <h1 className="page-title">Organize a music library</h1>
      <p className="page-lede">
        Point at a messy folder, choose where the clean copy goes, and run it. The reorg runs as a separate
        process on this machine — your originals are never modified, only copied into a tidy new tree.
      </p>

      <div className="panel form">
        <div className="form-row">
          <label className="field grow">
            <span>Source — the messy music folder</span>
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="sb-input"
              placeholder="e.g.  Y:\   or   D:\Music\Unsorted"
              disabled={running}
              spellCheck={false}
            />
          </label>
          <button className="btn ghost end" onClick={pickSource} disabled={running}>
            Browse…
          </button>
        </div>

        <div className="form-row">
          <label className="field grow">
            <span>Destination — a new folder, outside the source</span>
            <input
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              className="sb-input"
              disabled={running}
              spellCheck={false}
            />
          </label>
          <button className="btn ghost end" onClick={pickDest} disabled={running}>
            Browse…
          </button>
        </div>

        <div className="form-row">
          <label className="field grow">
            <span>Naming scheme</span>
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              className="sb-input"
              disabled={running}
            >
              {Object.entries(presets).map(([k, p]) => (
                <option key={k} value={k}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="check end">
            <input
              type="checkbox"
              checked={writeTags}
              onChange={(e) => setWriteTags(e.target.checked)}
              disabled={running}
            />
            Write corrected tags onto copies
          </label>
        </div>

        <div className="form-actions">
          <button
            className="btn ghost"
            onClick={simulate}
            disabled={simulating || planning || running || noSource}
            title="Compare all naming schemes by how many sparse folders each would create"
          >
            {simulating ? 'Simulating…' : 'Simulate schemes'}
          </button>
          <button className="btn ghost" onClick={preview} disabled={planning || running || noSource || noDest}>
            {planning ? 'Planning…' : 'Preview plan'}
          </button>
          {running ? (
            <button className="btn danger" onClick={cancel}>
              Cancel
            </button>
          ) : (
            <button className="btn primary" onClick={run} disabled={noSource || noDest}>
              Organize → copy
            </button>
          )}
          <span className="hint">Preview is a safe dry run. Originals are never modified.</span>
        </div>
      </div>

      {err && (
        <div className="panel err-text" style={{ marginTop: 16 }}>
          {err}
        </div>
      )}

      {sim && !job && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-title">
            Naming scheme comparison{' '}
            <span className="muted">
              {(sim.schemes[0]?.tracks ?? 0).toLocaleString()} tracks · dry run, nothing copied
            </span>
          </div>
          <p className="page-lede" style={{ margin: '0 0 14px', fontSize: 13.5 }}>
            A “sparse” folder holds just 1–2 songs — usually an album that got fragmented (e.g. tracks
            whose year tags disagree split across two folders). Fewer is cleaner. The bars show how many
            folders fall into each songs-per-folder bucket.
          </p>
          {(() => {
            const foldered = sim.schemes.filter((s) => s.key !== 'flat');
            const rec = sim.schemes.find((s) => s.key === sim.recommended);
            if (!rec || foldered.length === 0) return null;
            const minS = Math.min(...foldered.map((s) => s.sparseFolders));
            const maxS = Math.max(...foldered.map((s) => s.sparseFolders));
            const spread = maxS - minS;
            // Only call a scheme the winner when it meaningfully beats the others.
            const meaningful = spread >= 20 && spread / Math.max(1, rec.folders) >= 0.02;
            if (meaningful) {
              const worst = foldered.reduce((a, b) => (b.sparseFolders > a.sparseFolders ? b : a));
              return (
                <div className="scheme-verdict">
                  <span>✦</span>
                  <span>
                    <b className="ok-text">{rec.label}</b> makes{' '}
                    <b>{(worst.sparseFolders - rec.sparseFolders).toLocaleString()} fewer sparse folders</b>{' '}
                    than “{worst.label}” — it keeps more albums whole.
                  </span>
                </div>
              );
            }
            return (
              <div className="scheme-verdict warn">
                <span>!</span>
                <span>
                  The naming scheme barely changes the outcome — every foldered scheme leaves ~
                  <b>{minS.toLocaleString()}</b> sparse folders, and{' '}
                  <b>{rec.singletonFolders.toLocaleString()}</b> are single-track folders. The
                  fragmentation is in the source (loose / ungrouped tracks), not the scheme — pick any of
                  them.
                </span>
              </div>
            );
          })()}
          <div className="scheme-cmp">
            {sim.schemes.map((s) => {
              const maxH = Math.max(1, ...s.hist.map((h) => h.folders));
              const isBest = s.key === sim.recommended;
              const isFlat = s.key === 'flat';
              return (
                <div key={s.key} className={'scheme-col' + (isBest ? ' best' : '')}>
                  <div className="scheme-head">
                    <div className="scheme-label">{s.label}</div>
                    {isBest && <span className="badge good">fewest sparse</span>}
                  </div>
                  <div className="scheme-big">
                    <span className="big-n">{isFlat ? '—' : s.sparseFolders.toLocaleString()}</span>
                    <span className="big-l">
                      {isFlat ? 'flat — one folder for everything' : 'sparse folders (1–2 songs)'}
                    </span>
                  </div>
                  <div className="scheme-mini">
                    {s.hist.map((h) => (
                      <div
                        key={h.label}
                        className="mini-col"
                        title={`${h.folders.toLocaleString()} folder${h.folders === 1 ? '' : 's'} with ${h.label} song${h.label === '1' ? '' : 's'}`}
                      >
                        <div className="mini-bar" style={{ height: `${(h.folders / maxH) * 100}%` }} />
                        <div className="mini-lab">{h.label}</div>
                      </div>
                    ))}
                  </div>
                  <div className="scheme-stats">
                    <div>
                      <span>Folders</span>
                      <b>{s.folders.toLocaleString()}</b>
                    </div>
                    <div>
                      <span>Median / folder</span>
                      <b>{s.medianPerFolder}</b>
                    </div>
                    <div>
                      <span>Largest</span>
                      <b>{s.largestFolder.toLocaleString()}</b>
                    </div>
                    {s.collisions > 0 && (
                      <div>
                        <span>Collisions</span>
                        <b className="err-text">{s.collisions.toLocaleString()}</b>
                      </div>
                    )}
                  </div>
                  {preset === s.key ? (
                    <div className="scheme-sel">Selected ✓</div>
                  ) : (
                    <button className="btn ghost scheme-use" onClick={() => setPreset(s.key)}>
                      Use this scheme
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {plan && !job && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-title">
            Plan preview <span className="muted">dry run — nothing copied yet</span>
          </div>
          <div className="facts">
            <span>{plan.actions.toLocaleString()} files to copy</span>
            <span className="dotsep">·</span>
            <span>{plan.collisions} collisions</span>
            <span className="dotsep">·</span>
            <span>{plan.skipped} skipped</span>
          </div>
          <pre className="tree">
            {plan.sample.join('\n')}
            {plan.actions > plan.sample.length
              ? `\n… and ${(plan.actions - plan.sample.length).toLocaleString()} more`
              : ''}
          </pre>
        </div>
      )}

      {job && (
        <div className="panel" style={{ marginTop: 16 }}>
          {job.state === 'running' && (
            <div>
              <div className="sb-line">
                <span className="spinner-sm" /> {job.phase} — {job.done.toLocaleString()} /{' '}
                {job.total.toLocaleString()} files
                {job.pid ? <span className="muted"> · worker process #{job.pid}</span> : null}
              </div>
              {pct !== null && (
                <div className="sb-bar" style={{ marginTop: 10 }}>
                  <div className="sb-fill" style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>
          )}
          {job.state === 'done' && job.result && (
            <div>
              <div className="ok-text" style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                ✓ Organized {job.result.copied.toLocaleString()} files into <code>{job.result.dest}</code>
              </div>
              <div className="facts">
                <span>{job.result.copied.toLocaleString()} copied</span>
                <span className="dotsep">·</span>
                <span>{job.result.skipped} skipped</span>
                <span className="dotsep">·</span>
                <span>{job.result.failed} failed</span>
                {job.result.tagged ? (
                  <>
                    <span className="dotsep">·</span>
                    <span>{job.result.tagged} tagged</span>
                  </>
                ) : null}
                <span className="dotsep">·</span>
                <span>{Math.round(job.result.bytes / 1_048_576).toLocaleString()} MB</span>
              </div>
              <button
                className="btn primary"
                style={{ marginTop: 14 }}
                onClick={() => onOpenResult(job.result!.dest)}
              >
                Browse the organized library →
              </button>
            </div>
          )}
          {job.state === 'cancelled' && <div className="muted">Organize cancelled. Nothing further was copied.</div>}
          {job.state === 'error' && <div className="err-text">Organize failed: {job.error}</div>}
        </div>
      )}

      <MetadataSim />
    </>
  );
}
