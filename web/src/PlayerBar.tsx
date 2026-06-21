// Fixed bottom transport bar. Renders only when something is loaded into the player.
import type { CSSProperties } from 'react';
import { usePlayer } from './player';
import { Cover } from './ui';

function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const Play = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M7 5.2v13.6a1 1 0 0 0 1.54.84l10.5-6.8a1 1 0 0 0 0-1.68L8.54 4.36A1 1 0 0 0 7 5.2z" />
  </svg>
);
const Pause = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <rect x="6.5" y="5" width="3.6" height="14" rx="1.2" />
    <rect x="13.9" y="5" width="3.6" height="14" rx="1.2" />
  </svg>
);
const Prev = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <rect x="6" y="6" width="2.4" height="12" rx="1" />
    <path d="M19 7v10a1 1 0 0 1-1.5.86l-8-5a1 1 0 0 1 0-1.72l8-5A1 1 0 0 1 19 7z" />
  </svg>
);
const Next = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <rect x="15.6" y="6" width="2.4" height="12" rx="1" />
    <path d="M5 7v10a1 1 0 0 0 1.5.86l8-5a1 1 0 0 0 0-1.72l-8-5A1 1 0 0 0 5 7z" />
  </svg>
);
const Vol = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M11 5 6 9H3v6h3l5 4z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12" />
  </svg>
);

export default function PlayerBar() {
  const p = usePlayer();
  const cur = p.current;
  if (!cur) return null;

  return (
    <div className="player">
      <div className="player-np">
        {cur.albumId ? (
          <div className="player-cover">
            <Cover albumId={cur.albumId} title={cur.albumTitle ?? cur.title} />
          </div>
        ) : null}
        <div className="player-np-text">
          <div className="player-title" title={cur.title}>
            {cur.title}
          </div>
          <div className="player-artist" title={cur.artistName}>
            {p.error ? <span className="err-text">{p.error}</span> : cur.artistName}
          </div>
        </div>
      </div>

      <div className="player-center">
        <div className="player-ctrls">
          <button className="pbtn" onClick={p.prev} disabled={p.index <= 0} aria-label="Previous">
            <Prev />
          </button>
          <button className="pbtn play" onClick={p.toggle} aria-label={p.isPlaying ? 'Pause' : 'Play'}>
            {p.isPlaying ? <Pause /> : <Play />}
          </button>
          <button
            className="pbtn"
            onClick={p.next}
            disabled={p.index >= p.queue.length - 1}
            aria-label="Next"
          >
            <Next />
          </button>
        </div>
        <div className="player-seek">
          <span className="t">{clock(p.currentTime)}</span>
          <input
            className="range seek"
            type="range"
            min={0}
            max={p.duration || 0}
            step="0.1"
            value={Math.min(p.currentTime, p.duration || 0)}
            onChange={(e) => p.seek(Number(e.currentTarget.value))}
            style={{ '--pct': `${p.duration > 0 ? (p.currentTime / p.duration) * 100 : 0}%` } as CSSProperties}
            aria-label="Seek"
          />
          <span className="t">{clock(p.duration)}</span>
        </div>
      </div>

      <div className="player-right">
        <Vol />
        <input
          className="range vol"
          type="range"
          min={0}
          max={1}
          step="0.01"
          value={p.volume}
          onChange={(e) => p.setVolume(Number(e.currentTarget.value))}
          style={{ '--pct': `${p.volume * 100}%` } as CSSProperties}
          aria-label="Volume"
        />
      </div>
    </div>
  );
}
