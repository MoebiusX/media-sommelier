// Full-screen lyrics view — built to be read "from afar": large auto-scrolling karaoke lines for
// time-synced lyrics, big readable text otherwise. Reuses the global player so transport keeps working.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { usePlayer } from './player';
import { api, type LyricsResult } from './api';
import { Cover } from './ui';

function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const SCALE_KEY = 'somm.lyricsScale';
const MIN_SCALE = 0.7;
const MAX_SCALE = 2.4;

/**
 * Smoothly scroll a container to a target scrollTop by tweening `scrollTop` directly. We don't use
 * `scrollIntoView({ behavior: 'smooth' })` / CSS `scroll-behavior` because some renderers silently
 * ignore them (the scroll never happens). Returns the rAF id so callers can cancel an in-flight tween.
 */
function smoothScrollTo(el: HTMLElement, to: number): number {
  const start = el.scrollTop;
  const dest = Math.max(0, Math.min(to, el.scrollHeight - el.clientHeight));
  const dist = dest - start;
  if (Math.abs(dist) < 2) {
    el.scrollTop = dest;
    return 0;
  }
  const dur = 420;
  const ease = (p: number) => 1 - Math.pow(1 - p, 3);
  let raf = 0;
  let t0 = 0;
  const step = (ts: number) => {
    if (!t0) t0 = ts;
    const p = Math.min(1, (ts - t0) / dur);
    el.scrollTop = start + dist * ease(p);
    if (p < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return raf;
}

const Play = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M7 5.2v13.6a1 1 0 0 0 1.54.84l10.5-6.8a1 1 0 0 0 0-1.68L8.54 4.36A1 1 0 0 0 7 5.2z" />
  </svg>
);
const Pause = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <rect x="6.5" y="5" width="3.6" height="14" rx="1.2" />
    <rect x="13.9" y="5" width="3.6" height="14" rx="1.2" />
  </svg>
);
const Prev = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <rect x="6" y="6" width="2.4" height="12" rx="1" />
    <path d="M19 7v10a1 1 0 0 1-1.5.86l-8-5a1 1 0 0 1 0-1.72l8-5A1 1 0 0 1 19 7z" />
  </svg>
);
const Next = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <rect x="15.6" y="6" width="2.4" height="12" rx="1" />
    <path d="M5 7v10a1 1 0 0 0 1.5.86l8-5a1 1 0 0 0 0-1.72l-8-5A1 1 0 0 0 5 7z" />
  </svg>
);
const Expand = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3" />
  </svg>
);
const Collapse = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M21 16h-3a2 2 0 0 0-2 2v3M3 16h3a2 2 0 0 1 2 2v3" />
  </svg>
);

export default function Lyrics({ onClose }: { onClose: () => void }) {
  const p = usePlayer();
  const cur = p.current;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const linesRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);

  const [data, setData] = useState<LyricsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [isFs, setIsFs] = useState(false);
  const [scale, setScale] = useState<number>(() => {
    const v = Number(localStorage.getItem(SCALE_KEY));
    return Number.isFinite(v) && v >= MIN_SCALE && v <= MAX_SCALE ? v : 1;
  });

  // Fetch lyrics for the active track (re-fetch when the track changes).
  useEffect(() => {
    if (!cur) return;
    let alive = true;
    setLoading(true);
    setData(null);
    api
      .lyrics(cur.path)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData({ ok: false, source: null, synced: null, plain: null }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [cur?.path]);

  useEffect(() => {
    localStorage.setItem(SCALE_KEY, String(scale));
  }, [scale]);

  // Track true-fullscreen state so the button reflects it.
  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Esc closes the overlay (but only when NOT in browser fullscreen — there Esc exits fullscreen first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const synced = data?.synced && data.synced.length > 0 ? data.synced : null;

  // Active line = the last synced line whose timestamp has passed (small lead so it flips a touch early).
  const activeIndex = useMemo(() => {
    if (!synced) return -1;
    const t = p.currentTime + 0.2;
    let idx = -1;
    for (let i = 0; i < synced.length; i++) {
      if ((synced[i]?.time ?? Infinity) <= t) idx = i;
      else break;
    }
    return idx;
  }, [synced, p.currentTime]);

  // Keep the active line centered. Look the node up by index off a stable container ref (swapping a
  // single ref between sibling lines is unreliable — React can null it out mid-reconcile) and tween
  // the scroll manually so it works in every renderer.
  useEffect(() => {
    if (activeIndex < 0) return;
    const container = bodyRef.current;
    const el = linesRef.current?.children[activeIndex] as HTMLElement | undefined;
    if (!container || !el) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const target = container.scrollTop + (eRect.top - cRect.top) - (container.clientHeight - eRect.height) / 2;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = smoothScrollTo(container, target);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [activeIndex]);

  if (!cur) return null;

  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void rootRef.current?.requestFullscreen().catch(() => {});
  };
  const bump = (d: number) => setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((s + d) * 100) / 100)));

  const sourceLabel =
    data?.source === 'sidecar' ? '.lrc' : data?.source === 'embedded' ? 'embedded' : data?.source === 'lrclib' ? 'lrclib.net' : null;

  return (
    <div className="lyrics-overlay" ref={rootRef} style={{ '--ly-scale': scale } as CSSProperties}>
      <div className="lyrics-head">
        <div className="lyrics-np">
          {cur.albumId ? (
            <div className="lyrics-cover">
              <Cover albumId={cur.albumId} title={cur.albumTitle ?? cur.title} />
            </div>
          ) : null}
          <div className="lyrics-np-text">
            <div className="lyrics-track" title={cur.title}>
              {cur.title}
            </div>
            <div className="lyrics-artist" title={cur.artistName}>
              {cur.artistName}
              {sourceLabel ? <span className="lyrics-src">{sourceLabel}</span> : null}
            </div>
          </div>
        </div>
        <div className="lyrics-tools">
          <button className="ly-btn" onClick={() => bump(-0.15)} disabled={scale <= MIN_SCALE} aria-label="Smaller text" title="Smaller text">
            A−
          </button>
          <button className="ly-btn" onClick={() => bump(0.15)} disabled={scale >= MAX_SCALE} aria-label="Bigger text" title="Bigger text">
            A+
          </button>
          <button className="ly-btn" onClick={toggleFs} aria-label="Toggle fullscreen" title={isFs ? 'Exit fullscreen' : 'Fullscreen'}>
            {isFs ? <Collapse /> : <Expand />}
          </button>
          <button className="ly-btn ly-close" onClick={onClose} aria-label="Close lyrics" title="Close (Esc)">
            ✕
          </button>
        </div>
      </div>

      <div className="lyrics-body" ref={bodyRef}>
        {loading ? (
          <div className="lyrics-msg">
            <span className="spinner" />
          </div>
        ) : synced ? (
          <div className="lyrics-lines" ref={linesRef}>
            {synced.map((l, i) => (
              <div
                key={i}
                className={'lyrics-line' + (i === activeIndex ? ' active' : i < activeIndex ? ' past' : '')}
                onClick={() => p.seek(l.time)}
                title="Jump to this line"
              >
                {l.text || '♪'}
              </div>
            ))}
          </div>
        ) : data?.plain ? (
          <pre className="lyrics-plain">{data.plain}</pre>
        ) : (
          <div className="lyrics-msg lyrics-empty">
            <div className="lyrics-empty-art">♪</div>
            <div>No lyrics found for this track.</div>
            <div className="muted">Checked the file’s tags, a sidecar .lrc, and lrclib.net.</div>
          </div>
        )}
      </div>

      <div className="lyrics-foot">
        <span className="ly-t">{clock(p.currentTime)}</span>
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
        <span className="ly-t">{clock(p.duration)}</span>
        <div className="lyrics-ctrls">
          <button className="pbtn" onClick={p.prev} disabled={p.index <= 0} aria-label="Previous">
            <Prev />
          </button>
          <button className="pbtn play" onClick={p.toggle} aria-label={p.isPlaying ? 'Pause' : 'Play'}>
            {p.isPlaying ? <Pause /> : <Play />}
          </button>
          <button className="pbtn" onClick={p.next} disabled={p.index >= p.queue.length - 1} aria-label="Next">
            <Next />
          </button>
        </div>
      </div>
    </div>
  );
}
