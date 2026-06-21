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

export interface PlayerTrack {
  id: number;
  title: string;
  artistName: string;
  path: string;
  durationMs: number | null;
  albumId?: string;
  albumTitle?: string;
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
    setQueue(tracks);
    setIndex(Math.max(0, Math.min(startIndex, tracks.length - 1)));
    setError(null);
  }, []);

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
    }),
    [queue, index, current, isPlaying, currentTime, duration, volume, error, playQueue, toggle, next, prev, seek, setVolume, repeat, toggleRepeat, shuffle],
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
