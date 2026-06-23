// Auto DJ — start an endless queue that plays by mood or style. The picker lists the moods/styles
// actually present in the library (with counts); selecting one (or "Surprise me", or seeding from the
// current song) hands off to the player's startAutoDj(), which then keeps the queue topped up on-vibe.
import { useEffect, useState } from 'react';
import { usePlayer } from './player';
import { api, type DjMoodsResult } from './api';

const Radio = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4.5 9.5 18 4" />
    <rect x="3" y="9" width="18" height="11" rx="2" />
    <circle cx="8" cy="14.5" r="2.5" />
    <path d="M16 13.5v2" />
  </svg>
);

export function AutoDjPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = usePlayer();
  const [data, setData] = useState<DjMoodsResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setData(null);
    setErr(null);
    api
      .djMoods()
      .then(setData)
      .catch(() => setErr('Could not load moods — scan a library first.'));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const start = (seed: Parameters<typeof p.startAutoDj>[0]) => {
    void p.startAutoDj(seed);
    onClose();
  };

  return (
    <div className="cp-backdrop dj-backdrop" onClick={onClose}>
      <div className="dj-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Auto DJ">
        <div className="dj-head">
          <div className="dj-head-title">
            <Radio size={20} />
            <span>Auto DJ</span>
          </div>
          <button className="queue-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="dj-sub">Plays an endless set by mood or style — it tops itself up as it goes.</div>

        {err ? <div className="dj-empty">{err}</div> : !data ? <div className="dj-empty"><span className="spinner" /></div> : (
          <div className="dj-body">
            <div className="dj-quick">
              <button className="dj-quick-btn primary" onClick={() => start({})}>
                🎲 Surprise me
              </button>
              {p.current && (
                <button className="dj-quick-btn" onClick={() => start({ seedPath: p.current!.path })}>
                  Start from “{p.current.title}”
                </button>
              )}
              {p.autoDj && (
                <button className="dj-quick-btn off" onClick={() => { p.stopAutoDj(); onClose(); }}>
                  Turn off Auto DJ
                </button>
              )}
            </div>

            <div className="dj-section-label">By mood</div>
            <div className="dj-chips">
              {data.moods.map((m) => (
                <button key={m.key} className="dj-chip" onClick={() => start({ mood: m.key })}>
                  <span className="dj-chip-label">{m.label}</span>
                  <span className="dj-chip-count">{m.tracks.toLocaleString()}</span>
                </button>
              ))}
            </div>

            <div className="dj-section-label">By style</div>
            <div className="dj-chips">
              {data.styles.map((s) => (
                <button key={s.key} className="dj-chip" onClick={() => start({ style: s.key })}>
                  <span className="dj-chip-label">{s.label}</span>
                  <span className="dj-chip-count">{s.tracks.toLocaleString()}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Sidebar entry point — always visible, even when nothing is playing. */
export function AutoDjLauncher() {
  const p = usePlayer();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={'sidebar-dj' + (p.autoDj ? ' on' : '')} onClick={() => setOpen(true)}>
        <Radio />
        <span className="sidebar-dj-text">{p.autoDj ? `Auto DJ · ${p.autoDj.label}` : 'Auto DJ'}</span>
        {p.autoDj && <span className="sidebar-dj-live">LIVE</span>}
      </button>
      <AutoDjPicker open={open} onClose={() => setOpen(false)} />
    </>
  );
}
