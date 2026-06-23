// Global audio player: owns the single <audio> element, the play queue, and transport state.
// Any view can call usePlayer().playQueue(tracks, i) to start playback; the PlayerBar renders the UI.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';

export interface PlayerTrack {
  id: number;
  title: string;
  artistName: string;
  path: string;
  durationMs: number | null;
  albumId?: string;
  albumTitle?: string;
  /** Auto DJ "why this track" trace, when the queue came from a station. */
  reason?: string[];
}

/** Active Auto DJ station: the queue endlessly extends with on-vibe tracks until turned off. */
export interface AutoDjState {
  label: string;
  mood?: string;
  style?: string;
}

/** Start an Auto DJ station by mood, style, a seed track, or an artist ("surprise me" = no args). */
export interface AutoDjSeed {
  mood?: string;
  style?: string;
  seedPath?: string;
  artist?: string;
}

interface PlayerApi {
  queue: PlayerTrack[];
  index: number;
  current: PlayerTrack | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  error: string | null;
  /** Replace the queue and start playing at startIndex. */
  playQueue: (tracks: PlayerTrack[], startIndex: number) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (sec: number) => void;
  setVolume: (v: number) => void;
  repeat: boolean;
  toggleRepeat: () => void;
  shuffle: () => void;
  /** Active Auto DJ station, or null. */
  autoDj: AutoDjState | null;
  /** Start an endless mood/style station; replaces the queue and begins playing. */
  startAutoDj: (seed: AutoDjSeed) => Promise<void>;
  /** Turn the station off (keeps the current queue playing, just stops auto-extending). */
  stopAutoDj: () => void;
}

const Ctx = createContext<PlayerApi | null>(null);

/** Streaming URL for an indexed track (Range-served + confined by the API). */
export function audioUrl(path: string): string {
  return `/api/audio?path=${encodeURIComponent(path)}`;
}

export function usePlayer(): PlayerApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePlayer must be used within <PlayerProvider>');
  return v;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<PlayerTrack[]>([]);
  const [index, setIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVol] = useState(1);
  const [repeat, setRepeat] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoDj, setAutoDj] = useState<AutoDjState | null>(null);
  const autoDjRef = useRef<AutoDjState | null>(null);
  autoDjRef.current = autoDj;
  const extendingRef = useRef(false); // guards against overlapping auto-extend fetches

  // mirrors so event handlers (onEnded, keydown) see the latest without stale closures
  const queueLenRef = useRef(0);
  queueLenRef.current = queue.length;
  const queueRef = useRef<PlayerTrack[]>([]);
  queueRef.current = queue;
  const indexRef = useRef(-1);
  indexRef.current = index;
  const repeatRef = useRef(false);
  repeatRef.current = repeat;

  const current = index >= 0 && index < queue.length ? queue[index]! : null;

  const playQueue = useCallback((tracks: PlayerTrack[], startIndex: number) => {
    if (tracks.length === 0) return;
    setAutoDj(null); // manually choosing what to play exits Auto DJ
    setQueue(tracks);
    setIndex(Math.max(0, Math.min(startIndex, tracks.length - 1)));
    setError(null);
  }, []);

  const startAutoDj = useCallback(async (seed: AutoDjSeed) => {
    try {
      const r = await api.djQueue({ ...seed, limit: 40 });
      if (r.tracks.length === 0) {
        setError('No tracks match that vibe.');
        return;
      }
      setAutoDj({ label: r.target.label, ...(r.target.mood ? { mood: r.target.mood } : {}), ...(r.target.style ? { style: r.target.style } : {}) });
      setQueue(r.tracks);
      setIndex(0);
      setError(null);
    } catch {
      setError('Auto DJ is unavailable.');
    }
  }, []);

  const stopAutoDj = useCallback(() => setAutoDj(null), []);

  const next = useCallback(() => setIndex((i) => Math.min(i + 1, queueLenRef.current - 1)), []);
  const prev = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);
  const toggleRepeat = useCallback(() => setRepeat((r) => !r), []);
  /** Fisher-Yates shuffle the queue, keeping the current track playing at its new position. */
  const shuffle = useCallback(() => {
    const q = queueRef.current;
    if (q.length < 2) return;
    const curPath = q[indexRef.current]?.path;
    const arr = [...q];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    const ni = arr.findIndex((t) => t.path === curPath);
    setQueue(arr);
    setIndex(ni >= 0 ? ni : 0);
  }, []);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a || !a.src) return;
    if (a.paused) void a.play().catch(() => {});
    else a.pause();
  }, []);

  const seek = useCallback((sec: number) => {
    const a = audioRef.current;
    if (a && Number.isFinite(sec)) a.currentTime = sec;
  }, []);

  const setVolume = useCallback((v: number) => {
    setVol(v);
    if (audioRef.current) audioRef.current.volume = v;
  }, []);

  // Load + play whenever the active track changes (keyed on path so re-renders don't reload).
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !current) return;
    a.src = audioUrl(current.path);
    a.load();
    setError(null);
    setCurrentTime(0);
    void a.play().catch(() => {
      /* autoplay block or undecodable codec — surfaced via the audio 'error' event */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.path]);

  const onEnded = useCallback(() => {
    setIndex((i) => {
      if (i + 1 < queueLenRef.current) return i + 1;
      if (repeatRef.current && queueLenRef.current > 0) return 0; // repeat all → loop to start
      setIsPlaying(false);
      return i;
    });
  }, []);

  // Global keyboard transport: Space play/pause, ←/→ seek ±5s, Shift+←/→ prev/next.
  // Ignored while typing in a field or with the command palette open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = audioRef.current;
      if (!a || index < 0) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.cp-backdrop')) return; // palette/modal open
      if (e.key === ' ') {
        e.preventDefault();
        if (a.paused) void a.play().catch(() => {});
        else a.pause();
      } else if (e.key === 'ArrowRight' && e.shiftKey) {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, queueLenRef.current - 1));
      } else if (e.key === 'ArrowLeft' && e.shiftKey) {
        e.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        a.currentTime = Math.min(a.currentTime + 5, a.duration || a.currentTime + 5);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        a.currentTime = Math.max(a.currentTime - 5, 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index]);

  // Endless station: when Auto DJ is on and we're within 3 tracks of the end, fetch more on-vibe tracks
  // (seeded by the last queued track, excluding everything already queued) and append them.
  useEffect(() => {
    const dj = autoDj;
    if (!dj || index < 0 || index < queue.length - 3 || extendingRef.current) return;
    const last = queue[queue.length - 1];
    if (!last) return;
    extendingRef.current = true;
    const exclude = queue.map((t) => t.path);
    api
      .djQueue({ ...(dj.mood ? { mood: dj.mood } : {}), ...(dj.style ? { style: dj.style } : {}), seedPath: last.path, exclude, limit: 20 })
      .then((r) => {
        if (!autoDjRef.current) return; // turned off while fetching
        const seen = new Set(exclude);
        const more = r.tracks.filter((t) => !seen.has(t.path));
        if (more.length) setQueue((q) => [...q, ...more]);
      })
      .catch(() => {})
      .finally(() => {
        extendingRef.current = false;
      });
  }, [index, queue, autoDj]);

  const value = useMemo<PlayerApi>(
    () => ({
      queue,
      index,
      current,
      isPlaying,
      currentTime,
      duration,
      volume,
      error,
      playQueue,
      toggle,
      next,
      prev,
      seek,
      setVolume,
      repeat,
      toggleRepeat,
      shuffle,
      autoDj,
      startAutoDj,
      stopAutoDj,
    }),
    [queue, index, current, isPlaying, currentTime, duration, volume, error, playQueue, toggle, next, prev, seek, setVolume, repeat, toggleRepeat, shuffle, autoDj, startAutoDj, stopAutoDj],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <audio
        ref={audioRef}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onEnded={onEnded}
        onError={() => {
          setIsPlaying(false);
          setError(current ? `Can’t play “${current.title}” (unsupported format?)` : 'Playback error');
        }}
      />
    </Ctx.Provider>
  );
}
