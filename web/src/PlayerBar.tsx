// Fixed bottom transport bar. Renders only when something is loaded into the player.
import { useState, type CSSProperties } from 'react';
import { usePlayer } from './player';
import { fmtDuration } from './api';
import { Cover } from './ui';
import Lyrics from './Lyrics';
import { AutoDjPicker } from './AutoDj';

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
const Shuffle = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
  </svg>
);
const Repeat = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M17 2l4 4-4 4" />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4" />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" />
  </svg>
);
const QueueIco = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 6h11M4 12h11M4 18h7" />
    <path d="M17 14v6l4-2.2z" fill="currentColor" stroke="none" />
  </svg>
);
const LyricsIco = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 7h13M4 12h10M4 17h7" />
    <circle cx="18.5" cy="15.5" r="2.5" />
    <path d="M21 15.5V8l-3 1" />
  </svg>
);
const RadioIco = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4.5 9.5 18 4" />
    <rect x="3" y="9" width="18" height="11" rx="2" />
    <circle cx="8" cy="14.5" r="2.5" />
    <path d="M16 13.5v2" />
  </svg>
);

export default function PlayerBar({
  onOpenAlbum,
}: {
  onOpenAlbum?: (albumId: string, artistName: string) => void;
}) {
  const p = usePlayer();
  const [showQueue, setShowQueue] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [showDj, setShowDj] = useState(false);
  const cur = p.current;
  if (!cur) return null;

  const canOpenAlbum = !!(cur.albumId && onOpenAlbum);
  const openAlbum = () => {
    if (cur.albumId && onOpenAlbum) onOpenAlbum(cur.albumId, cur.artistName);
  };

  return (
    <>
    <div className="player">
      <div
        className={'player-np' + (canOpenAlbum ? ' clickable' : '')}
        onClick={canOpenAlbum ? openAlbum : undefined}
        title={canOpenAlbum ? 'Open album' : undefined}
        role={canOpenAlbum ? 'button' : undefined}
      >
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
            {p.error ? (
              <span className="err-text">{p.error}</span>
            ) : p.autoDj ? (
              <>
                <span className="dj-pill" title={`Auto DJ · ${p.autoDj.label}`}>
                  <span className="dj-pill-dot" />
                  {p.autoDj.label}
                </span>
                {cur.artistName}
              </>
            ) : (
              cur.artistName
            )}
          </div>
        </div>
      </div>

      <div className="player-center">
        <div className="player-ctrls">
          <button
            className="pbtn small"
            onClick={p.shuffle}
            disabled={p.queue.length < 2}
            aria-label="Shuffle"
            title="Shuffle queue"
          >
            <Shuffle />
          </button>
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
          <button
            className={'pbtn small' + (p.repeat ? ' on' : '')}
            onClick={p.toggleRepeat}
            aria-label="Repeat"
            title={p.repeat ? 'Repeat: on' : 'Repeat: off'}
          >
            <Repeat />
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
        <button
          className={'pbtn qbtn' + (p.autoDj ? ' on' : '')}
          onClick={() => setShowDj(true)}
          aria-label="Auto DJ"
          title="Auto DJ — play by mood/style"
        >
          <RadioIco />
        </button>
        <button
          className={'pbtn qbtn' + (showLyrics ? ' on' : '')}
          onClick={() => setShowLyrics((v) => !v)}
          aria-label="Lyrics"
          title="Lyrics (full screen)"
        >
          <LyricsIco />
        </button>
        <button
          className={'pbtn qbtn' + (showQueue ? ' on' : '')}
          onClick={() => setShowQueue((v) => !v)}
          aria-label="Queue"
          title="Queue"
        >
          <QueueIco />
        </button>
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

      {showQueue && (
        <div className="queue-pop">
          <div className="queue-head">
            <span>
              {p.autoDj ? 'Auto DJ' : 'Queue'} <span className="muted">· {p.queue.length} tracks{p.autoDj ? ' · live' : ''}</span>
            </span>
            <button className="queue-x" onClick={() => setShowQueue(false)} aria-label="Close">
              ✕
            </button>
          </div>
          <div className="queue-list">
            {p.queue.map((t, i) => {
              const active = i === p.index;
              return (
                <div
                  key={`${t.id}-${i}`}
                  className={'queue-row' + (active ? ' active' : '')}
                  onClick={() => (active ? p.toggle() : p.playQueue(p.queue, i))}
                >
                  <div className="q-no">
                    {active ? (
                      <span className={'eq' + (p.isPlaying ? ' on' : '')} aria-hidden>
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : (
                      i + 1
                    )}
                  </div>
                  <div className="q-main">
                    <div className="q-title" title={t.title}>
                      {t.title}
                    </div>
                    <div className="q-artist" title={t.artistName}>
                      {t.artistName}
                    </div>
                  </div>
                  <div className="q-dur">{fmtDuration(t.durationMs)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
    {showLyrics && <Lyrics onClose={() => setShowLyrics(false)} />}
    <AutoDjPicker open={showDj} onClose={() => setShowDj(false)} />
    </>
  );
}
