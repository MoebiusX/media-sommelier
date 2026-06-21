import { useEffect, useState } from 'react';
import { api, type OrganizeStatus, type PlanSummary, type Preset } from './api';

/**
 * The Organize control — the payoff. Pick a destination + naming scheme, Preview the plan (dry run),
 * then Organize (copy) which genuinely copies the reconstructed library into a NEW tree (originals are
 * never touched — the engine enforces dest-outside-source + collision-fail). When done, you can browse
 * the organized result by scanning the destination.
 */
export default function Organize({
  source,
  onOpenResult,
}: {
  source: string;
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
      setJob({ state: 'running', phase: 'planning', done: 0, total: 0 });
      // poll until done/error
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((r) => setTimeout(r, 1200));
        const s = await api.organizeStatus();
        setJob(s);
        if (s.state === 'done' || s.state === 'error') break;
      }
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  return (
    <>
      <h1 className="page-title">Organize</h1>
      <p className="page-lede">
        Copy your library into a clean, reconstructed tree. Originals are never modified — this only ever
        copies.
      </p>

      {noSource && (
        <div className="empty">Point at a source folder up top and Scan it first, then come back here.</div>
      )}

      <div className="panel form">
        <label className="field">
          <span>Source</span>
          <input value={source} readOnly className="sb-input" placeholder="(scan a folder first)" />
        </label>

        <div className="form-row">
          <label className="field grow">
            <span>Destination (a new, empty-ish folder outside the source)</span>
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
          <button className="btn ghost" onClick={preview} disabled={planning || running || noSource}>
            {planning ? 'Planning…' : 'Preview plan'}
          </button>
          <button className="btn primary" onClick={run} disabled={running || noSource}>
            {running ? 'Organizing…' : 'Organize (copy)'}
          </button>
          <span className="hint">Preview is a safe dry run. Copy never modifies originals.</span>
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
            <div className="sb-line">
              <span className="spinner-sm" /> {job.phase} — {job.done.toLocaleString()} /{' '}
              {job.total.toLocaleString()} files copied
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
              <button className="btn primary" style={{ marginTop: 14 }} onClick={() => onOpenResult(job.result!.dest)}>
                Browse the organized library →
              </button>
            </div>
          )}
          {job.state === 'error' && <div className="err-text">Organize failed: {job.error}</div>}
        </div>
      )}
    </>
  );
}
