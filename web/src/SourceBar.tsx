import { type ScanStatus } from './api';

/**
 * The "point at a folder" control. Always visible above the content: type/Browse a folder, hit Scan,
 * and watch it index into SQLite with live progress. Scan state + polling live in App (shared with
 * Organize's "browse the result"); this component is presentational.
 */
export default function SourceBar({
  source,
  setSource,
  scan,
  onScan,
  onPick,
}: {
  source: string;
  setSource: (s: string) => void;
  scan: ScanStatus | null;
  onScan: () => void;
  onPick: () => void;
}) {
  const running = scan?.state === 'running';
  const pct = scan && scan.total > 0 ? Math.round((scan.done / scan.total) * 100) : null;

  return (
    <div className="sourcebar">
      <div className="sb-row">
        <input
          className="sb-input"
          placeholder="Point at a music folder — e.g.  Y:\   or   D:\Music"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onScan();
          }}
          disabled={running}
          spellCheck={false}
        />
        <button className="btn ghost" onClick={onPick} disabled={running}>
          Browse…
        </button>
        <button className="btn primary" onClick={onScan} disabled={running || !source.trim()}>
          {running ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      {scan && scan.state !== 'idle' && (
        <div className="sb-status">
          <div className="sb-line">
            {running && <span className="spinner-sm" />}
            {scan.state === 'running' && (
              <span>
                Indexing <code>{scan.source}</code> — {scan.phase}
                {scan.total > 0
                  ? ` (${scan.done.toLocaleString()} / ${scan.total.toLocaleString()})`
                  : ''}
              </span>
            )}
            {scan.state === 'done' && scan.result && (
              <span className="ok-text">
                ✓ Indexed {scan.result.tracks.toLocaleString()} tracks ·{' '}
                {scan.result.albums.toLocaleString()} albums · {scan.result.artists.toLocaleString()}{' '}
                artists
              </span>
            )}
            {scan.state === 'error' && <span className="err-text">Scan failed: {scan.error}</span>}
          </div>
          {pct !== null && running && (
            <div className="sb-bar">
              <div className="sb-fill" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
