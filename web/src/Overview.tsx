import { useEffect, useState } from 'react';
import { api, fmtInt, fmtRuntime, type Overview } from './api';
import { ErrorState, Loading } from './ui';

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function BarList({
  rows,
  onPick,
}: {
  rows: Array<{ name: string; value: number }>;
  onPick?: (name: string) => void;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bars">
      {rows.map((r) => (
        <div
          key={r.name}
          className={'bar' + (onPick ? ' clickable' : '')}
          onClick={onPick ? () => onPick(r.name) : undefined}
        >
          <div className="name" title={r.name}>
            {r.name}
          </div>
          <div className="track">
            <div className="fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <div className="val">{fmtInt(r.value)}</div>
        </div>
      ))}
    </div>
  );
}

export default function OverviewPage({ onArtist }: { onArtist: (name: string) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .overview()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <ErrorState message={error} />;
  if (!data) return <Loading label="Diagnosing your library…" />;

  const losslessPct = Math.round(data.losslessRatio * 100);
  const sim = data.simulation;
  const rescued = sim ? sim.tag.orphanTracks - sim.folder.orphanTracks : 0;

  return (
    <>
      <h1 className="page-title">Library Overview</h1>
      <p className="page-lede">
        The diagnosis of your collection — what is here, and how folder-based reconstruction kept it
        whole.
      </p>

      <div className="stat-grid">
        <StatCard label="Tracks" value={fmtInt(data.tracks)} />
        <StatCard label="Albums" value={fmtInt(data.albums)} sub="reconstructed" />
        <StatCard label="Artists" value={fmtInt(data.artists)} />
        <StatCard label="Total size" value={data.totalHuman} />
        <StatCard label="Runtime" value={fmtRuntime(data.totalDurationMs)} />
        <StatCard label="Lossless" value={`${losslessPct}%`} sub="of tracks" />
      </div>

      {sim && (
        <div className="sim">
          <h2 className="sim-headline">
            Folder reconstruction kept <b>{fmtInt(sim.folder.groups)} albums</b> whole that tag-matching
            would have shattered into <b>{fmtInt(rescued)} extra orphans</b>.
          </h2>
          <p className="sim-lede">
            Naive tag grouping splinters real releases — inconsistent or missing tags scatter tracks into
            singletons. Reconstructing from folder structure recovers the album the way it was actually
            ripped and stored.
          </p>
          <div className="sim-compare">
            <div className="sim-side">
              <h4>Tag-based grouping</h4>
              <div className="sim-metric">
                <span className="k">Groups</span>
                <span className="v">{fmtInt(sim.tag.groups)}</span>
              </div>
              <div className="sim-metric hl">
                <span className="k">Orphan tracks</span>
                <span className="v">{fmtInt(sim.tag.orphanTracks)}</span>
              </div>
            </div>
            <div className="sim-arrow">→</div>
            <div className="sim-side win">
              <h4>Folder reconstruction</h4>
              <div className="sim-metric">
                <span className="k">Albums</span>
                <span className="v">{fmtInt(sim.folder.groups)}</span>
              </div>
              <div className="sim-metric hl">
                <span className="k">Orphan tracks</span>
                <span className="v">{fmtInt(sim.folder.orphanTracks)}</span>
              </div>
            </div>
          </div>
          <div className="sim-verdict">
            <span className="badge good">verdict</span>
            <span>{sim.verdict}</span>
          </div>
        </div>
      )}

      <div className="panel-row">
        <div className="panel">
          <div className="panel-title">
            Top artists <span className="muted">by tracks</span>
          </div>
          <BarList
            rows={data.topArtists.map((a) => ({ name: a.name, value: a.tracks }))}
            onPick={onArtist}
          />
        </div>
        <div className="panel">
          <div className="panel-title">
            Top genres <span className="muted">by tracks</span>
          </div>
          <BarList rows={data.topGenres.map((g) => ({ name: g.name, value: g.tracks }))} />
        </div>
      </div>

      <div className="panel-row">
        <div className="panel">
          <div className="panel-title">
            Busiest years <span className="muted">by tracks</span>
          </div>
          <BarList rows={data.topYears.map((y) => ({ name: String(y.year), value: y.tracks }))} />
        </div>
        <div className="panel">
          <div className="panel-title">
            Formats <span className="muted">file count</span>
          </div>
          <div className="chips">
            {Object.entries(data.formats)
              .sort((a, b) => b[1] - a[1])
              .map(([fmt, ct]) => (
                <span className="chip" key={fmt}>
                  <span className="fmt">{fmt}</span>
                  <span className="ct">{fmtInt(ct)}</span>
                </span>
              ))}
          </div>
        </div>
      </div>
    </>
  );
}
