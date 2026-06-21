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
  const [error, setError] = useState<string | null>(null);

  // queue length mirror so event handlers (onEnded) see the latest without stale closures
  const queueLenRef = useRef(0);
  queueLenRef.current = queue.length;

  const current = index >= 0 && index < queue.length ? queue[index]! : null;

  const playQueue = useCallback((tracks: PlayerTrack[], startIndex: number) => {
    if (tracks.length === 0) return;
    setQueue(tracks);
    setIndex(Math.max(0, Math.min(startIndex, tracks.length - 1)));
    setError(null);
  }, []);

  const next = useCallback(() => setIndex((i) => Math.min(i + 1, queueLenRef.current - 1)), []);
  const prev = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

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
      setIsPlaying(false);
      return i;
    });
  }, []);

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
    }),
    [queue, index, current, isPlaying, currentTime, duration, volume, error, playQueue, toggle, next, prev, seek, setVolume],
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
