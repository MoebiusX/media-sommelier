import { useEffect, useState } from 'react';
import { api, type OrganizeStatus, type PlanSummary, type Preset } from './api';

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

  async function run() {
    setErr(null);
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
    </>
  );
}
