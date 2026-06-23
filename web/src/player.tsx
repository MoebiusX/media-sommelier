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
  /** Applied ReplayGain for the current track in dB (null when untagged / no normalization). */
  normalizationDb: number | null;
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

/**
 * Perceptual volume taper. A linear slider feels logarithmic to the ear — almost the whole audible range
 * gets crammed into the bottom 20% — so map the slider position s (0..1) through a dB curve instead.
 * s=1 → 0 dB (unity), s=0 → silence, with VOLUME_MIN_DB as the bottom of the usable range.
 */
const VOLUME_MIN_DB = -48;
export function sliderToGain(s: number): number {
  if (s <= 0) return 0;
  if (s >= 1) return 1;
  return 10 ** ((VOLUME_MIN_DB * (1 - s)) / 20);
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
  const [volume, setVol] = useState<number>(() => {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('somm.volume') : null;
    if (raw == null) return 1;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  });
  const [repeat, setRepeat] = useState(false);
  const [normalizationDb, setNormalizationDb] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoDj, setAutoDj] = useState<AutoDjState | null>(null);
  const autoDjRef = useRef<AutoDjState | null>(null);
  autoDjRef.current = autoDj;
  const extendingRef = useRef(false); // guards against overlapping auto-extend fetches

  // Web Audio graph, built once (lazily, on the first user gesture): the <audio> element is routed
  // src → normGain (ReplayGain) → userGain (perceptual volume) → destination. createMediaElementSource
  // can only be called ONCE per element, and once routed the element's own .volume is bypassed — so ALL
  // volume flows through userGain. Until the graph exists (or if Web Audio is unavailable) volume falls
  // back to element.volume. A second hidden <audio> (warmRef) only prefetches the next track.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const srcNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const normGainRef = useRef<GainNode | null>(null);
  const userGainRef = useRef<GainNode | null>(null);
  const warmRef = useRef<HTMLAudioElement | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const currentPathRef = useRef<string | null>(null);

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

  /** Set the perceptual volume — via userGain once the graph exists, else element.volume as a fallback. */
  const applyVolume = useCallback((s: number) => {
    const g = sliderToGain(s);
    if (userGainRef.current) userGainRef.current.gain.value = g;
    else if (audioRef.current) audioRef.current.volume = g;
  }, []);

  /** Build the Web Audio graph once. No-op if already built or Web Audio is unavailable. */
  const ensureGraph = useCallback(() => {
    if (audioCtxRef.current || !audioRef.current) return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // Web Audio unavailable — element.volume keeps working
    try {
      const ctx = new Ctor();
      const srcNode = ctx.createMediaElementSource(audioRef.current);
      const normGain = ctx.createGain();
      const userGain = ctx.createGain();
      srcNode.connect(normGain).connect(userGain).connect(ctx.destination);
      normGain.gain.value = 1; // 0 dB until a track's ReplayGain is known
      userGain.gain.value = sliderToGain(volumeRef.current);
      audioRef.current.volume = 1; // all volume now flows through userGain
      audioCtxRef.current = ctx;
      srcNodeRef.current = srcNode;
      normGainRef.current = normGain;
      userGainRef.current = userGain;
    } catch {
      /* graph build failed — leave element.volume in charge */
    }
  }, []);

  /** Build + resume the graph. Must run from a user gesture (autoplay policy suspends the context). */
  const kick = useCallback(() => {
    ensureGraph();
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }, [ensureGraph]);

  /** Fetch a track's ReplayGain and apply it to normGain, clamped so peaks never clip (no limiter). */
  const applyReplayGain = useCallback(async (path: string, albumId: string | undefined) => {
    const ng = normGainRef.current;
    if (!ng) return; // no graph → can't normalize (element.volume can't boost > 1)
    let r;
    try {
      r = await api.loudness(path);
    } catch {
      return;
    }
    if (currentPathRef.current !== path) return; // track changed while we were fetching
    // Album gain when the whole queue is one album (preserves intentional intra-album dynamics); else track.
    const q = queueRef.current;
    const albumMode = !!albumId && q.length > 0 && q.every((t) => t.albumId === albumId);
    const gainDb = albumMode ? (r.albumGainDb ?? r.trackGainDb) : (r.trackGainDb ?? r.albumGainDb);
    const peak = albumMode ? (r.albumPeak ?? r.trackPeak) : (r.trackPeak ?? r.albumPeak);
    if (gainDb == null) {
      ng.gain.value = 1;
      setNormalizationDb(null);
      return;
    }
    // Headroom clamp: peak·10^(gain/20) must stay ≤ 1.0. With no known peak, cap positive boost at +6 dB.
    const headroomDb = peak != null && peak > 0 ? -20 * Math.log10(peak) : 6;
    const effDb = Math.min(gainDb, headroomDb);
    ng.gain.value = 10 ** (effDb / 20);
    setNormalizationDb(effDb);
  }, []);

  const playQueue = useCallback((tracks: PlayerTrack[], startIndex: number) => {
    if (tracks.length === 0) return;
    kick(); // build/resume the audio graph within this user gesture
    setAutoDj(null); // manually choosing what to play exits Auto DJ
    setQueue(tracks);
    setIndex(Math.max(0, Math.min(startIndex, tracks.length - 1)));
    setError(null);
  }, [kick]);

  const startAutoDj = useCallback(async (seed: AutoDjSeed) => {
    kick(); // build/resume the audio graph within this user gesture
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
  }, [kick]);

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
    kick();
    if (a.paused) void a.play().catch(() => {});
    else a.pause();
  }, [kick]);

  const seek = useCallback((sec: number) => {
    const a = audioRef.current;
    if (a && Number.isFinite(sec)) a.currentTime = sec;
  }, []);

  const setVolume = useCallback((v: number) => {
    const s = Math.min(1, Math.max(0, v));
    setVol(s);
    try {
      localStorage.setItem('somm.volume', String(s));
    } catch {
      /* private mode / quota — non-fatal */
    }
    applyVolume(s);
  }, [applyVolume]);

  // Load + play whenever the active track changes (keyed on path so re-renders don't reload).
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !current) return;
    kick(); // this load is the tail of a user gesture — safe to build/resume the graph here too
    currentPathRef.current = current.path;
    if (normGainRef.current) normGainRef.current.gain.value = 1; // reset to 0 dB until RG is known
    setNormalizationDb(null);
    a.src = audioUrl(current.path);
    a.load();
    setError(null);
    setCurrentTime(0);
    void applyReplayGain(current.path, current.albumId); // level-match this track (graceful no-op if untagged)
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
        kick();
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
  }, [index, kick]);

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

  // Warm the next track so advancing is near-instant: a hidden, muted <audio> prefetches it. Combined with
  // Cache-Control on /api/audio, the main element reuses the cached bytes when it advances. The warmer
  // never plays, so it's NOT in the Web Audio graph. (Sample-accurate gapless / crossfade is a larger
  // element-swap change — deferred.)
  useEffect(() => {
    const w = warmRef.current;
    if (!w) return;
    const next = index >= 0 && index + 1 < queue.length ? queue[index + 1] : null;
    if (!next) return;
    const url = audioUrl(next.path);
    if (w.getAttribute('src') === url) return; // already warming this track
    w.src = url;
    w.preload = 'auto';
    w.load();
  }, [index, queue]);

  const value = useMemo<PlayerApi>(
    () => ({
      queue,
      index,
      current,
      isPlaying,
      currentTime,
      duration,
      volume,
      normalizationDb,
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
    [queue, index, current, isPlaying, currentTime, duration, volume, normalizationDb, error, playQueue, toggle, next, prev, seek, setVolume, repeat, toggleRepeat, shuffle, autoDj, startAutoDj, stopAutoDj],
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
      {/* Hidden next-track prefetcher — never played, only warms the cache for gap-free advancing. */}
      <audio ref={warmRef} preload="auto" muted aria-hidden="true" style={{ display: 'none' }} />
    </Ctx.Provider>
  );
}
