// Global audio player: owns two <audio> elements (for equal-power crossfade), the play queue, and
// transport state. Any view can call usePlayer().playQueue(tracks, i) to start playback; PlayerBar renders the UI.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
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
  /** Graphic-EQ preset, applied via three biquad bands in the Web Audio graph. */
  eqPreset: EqPreset;
  setEqPreset: (p: EqPreset) => void;
  /** Night/room mode — gentle compression that lifts quiet passages for across-the-room listening. */
  nightMode: boolean;
  setNightMode: (on: boolean) => void;
  /** Crossfade seconds between automatic track changes (0 = off). Album seams stay gapless. */
  crossfadeSec: number;
  setCrossfadeSec: (s: number) => void;
  /** Output devices + the selected sink (DAC/headphones/speakers); empty when unsupported. */
  outputs: AudioOutput[];
  outputId: string;
  setOutputId: (id: string) => Promise<void>;
  /** (Re)enumerate output devices — call when the picker opens. */
  refreshOutputs: () => Promise<void>;
  /** Whether output switching is supported here (Chromium AudioContext.setSinkId). */
  canPickOutput: boolean;
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

/** A 3-band EQ preset: low shelf (~120 Hz), mid peak (~1.5 kHz), high shelf (~6 kHz), gains in dB. */
export type EqPreset = 'flat' | 'bass' | 'vocal' | 'treble';
export const EQ_PRESETS: Record<EqPreset, { label: string; low: number; mid: number; high: number }> = {
  flat: { label: 'Flat', low: 0, mid: 0, high: 0 },
  bass: { label: 'Bass', low: 6, mid: 0, high: 2 },
  vocal: { label: 'Vocal', low: -1, mid: 4, high: 2 },
  treble: { label: 'Treble', low: 0, mid: 1, high: 5 },
};
export function isEqPreset(s: string | null): s is EqPreset {
  return s === 'flat' || s === 'bass' || s === 'vocal' || s === 'treble';
}

/** Allowed crossfade durations (seconds) offered in the UI. */
export const CROSSFADE_OPTIONS = [0, 2, 4, 8] as const;

/** An available audio output (DAC / headphones / speakers) for the output-device picker. */
export interface AudioOutput {
  id: string;
  label: string;
}

/** Push an EQ preset onto the three biquad bands. */
function applyEq(low: BiquadFilterNode, mid: BiquadFilterNode, high: BiquadFilterNode, preset: EqPreset): void {
  const p = EQ_PRESETS[preset];
  low.gain.value = p.low;
  mid.gain.value = p.mid;
  high.gain.value = p.high;
}

/**
 * Night/room mode: gentle compression that lifts quiet passages so vocals stay intelligible across a room,
 * plus makeup gain to restore level. OFF = a transparent bypass (ratio 1 does no gain reduction).
 */
function applyNight(comp: DynamicsCompressorNode, makeup: GainNode, on: boolean): void {
  if (on) {
    comp.threshold.value = -32;
    comp.knee.value = 24;
    comp.ratio.value = 5;
    comp.attack.value = 0.01;
    comp.release.value = 0.3;
    makeup.gain.value = 10 ** (5 / 20); // ~+5 dB makeup
  } else {
    comp.threshold.value = 0;
    comp.knee.value = 0;
    comp.ratio.value = 1; // ratio 1 = no compression → transparent
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    makeup.gain.value = 1;
  }
}

/** Compute the headroom-clamped ReplayGain (dB) for a track from its loudness tags, or null if untagged. */
function effectiveGainDb(
  r: { trackGainDb: number | null; albumGainDb: number | null; trackPeak: number | null; albumPeak: number | null },
  albumMode: boolean,
): number | null {
  const gainDb = albumMode ? (r.albumGainDb ?? r.trackGainDb) : (r.trackGainDb ?? r.albumGainDb);
  if (gainDb == null) return null;
  const peak = albumMode ? (r.albumPeak ?? r.trackPeak) : (r.trackPeak ?? r.albumPeak);
  // Headroom clamp: peak·10^(gain/20) must stay ≤ 1.0. With no known peak, cap positive boost at +6 dB.
  const headroomDb = peak != null && peak > 0 ? -20 * Math.log10(peak) : 6;
  return Math.min(gainDb, headroomDb);
}

export function usePlayer(): PlayerApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePlayer must be used within <PlayerProvider>');
  return v;
}

type AB = 'a' | 'b';

export function PlayerProvider({ children }: { children: ReactNode }) {
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
  const [eqPreset, setEqPresetState] = useState<EqPreset>(() => {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('somm.eq') : null;
    return isEqPreset(raw) ? raw : 'flat';
  });
  const [nightMode, setNightModeState] = useState<boolean>(
    () => typeof localStorage !== 'undefined' && localStorage.getItem('somm.night') === '1',
  );
  const [crossfadeSec, setCrossfadeSecState] = useState<number>(() => {
    const v = Number(typeof localStorage !== 'undefined' ? localStorage.getItem('somm.xfade') : null);
    return (CROSSFADE_OPTIONS as readonly number[]).includes(v) ? v : 0;
  });
  const [outputs, setOutputs] = useState<AudioOutput[]>([]);
  const [outputId, setOutputIdState] = useState<string>(
    () => (typeof localStorage !== 'undefined' ? localStorage.getItem('somm.sink') : null) ?? 'default',
  );
  const canPickOutput = useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.AudioContext !== 'undefined' &&
      'setSinkId' in (window.AudioContext.prototype as object),
    [],
  );
  const [autoDj, setAutoDj] = useState<AutoDjState | null>(null);
  const autoDjRef = useRef<AutoDjState | null>(null);
  autoDjRef.current = autoDj;
  const extendingRef = useRef(false); // guards against overlapping auto-extend fetches

  // Two <audio> elements through ONE Web Audio graph so we can crossfade between tracks. Each element:
  //   el → src → rg (ReplayGain) → fade (crossfade envelope) → [shared] EQ → comp → makeup → userGain → out
  // `activeAB` is which element holds the foreground (current) track; the other preloads the next one and
  // becomes the crossfade target. Volume flows through userGain (element.volume is bypassed once routed).
  const elARef = useRef<HTMLAudioElement | null>(null);
  const elBRef = useRef<HTMLAudioElement | null>(null);
  const activeABRef = useRef<AB>('a');
  const audioCtxRef = useRef<AudioContext | null>(null);
  const srcARef = useRef<MediaElementAudioSourceNode | null>(null);
  const srcBRef = useRef<MediaElementAudioSourceNode | null>(null);
  const rgARef = useRef<GainNode | null>(null);
  const rgBRef = useRef<GainNode | null>(null);
  const fadeARef = useRef<GainNode | null>(null);
  const fadeBRef = useRef<GainNode | null>(null);
  const eqLowRef = useRef<BiquadFilterNode | null>(null);
  const eqMidRef = useRef<BiquadFilterNode | null>(null);
  const eqHighRef = useRef<BiquadFilterNode | null>(null);
  const compRef = useRef<DynamicsCompressorNode | null>(null);
  const makeupRef = useRef<GainNode | null>(null);
  const userGainRef = useRef<GainNode | null>(null);
  const crossfadingRef = useRef(false);
  const crossfadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const eqPresetRef = useRef(eqPreset);
  eqPresetRef.current = eqPreset;
  const nightModeRef = useRef(nightMode);
  nightModeRef.current = nightMode;
  const crossfadeSecRef = useRef(crossfadeSec);
  crossfadeSecRef.current = crossfadeSec;
  const outputIdRef = useRef(outputId);
  outputIdRef.current = outputId;

  // mirrors so event handlers see the latest without stale closures
  const queueLenRef = useRef(0);
  queueLenRef.current = queue.length;
  const queueRef = useRef<PlayerTrack[]>([]);
  queueRef.current = queue;
  const indexRef = useRef(-1);
  indexRef.current = index;
  const repeatRef = useRef(false);
  repeatRef.current = repeat;

  const current = index >= 0 && index < queue.length ? queue[index]! : null;
  const currentRef = useRef<PlayerTrack | null>(null);
  currentRef.current = current;

  // ---- element/node accessors keyed on which side ('a'/'b') ----
  const elFor = useCallback((ab: AB) => (ab === 'a' ? elARef.current : elBRef.current), []);
  const rgFor = useCallback((ab: AB) => (ab === 'a' ? rgARef.current : rgBRef.current), []);
  const fadeFor = useCallback((ab: AB) => (ab === 'a' ? fadeARef.current : fadeBRef.current), []);
  const activeEl = useCallback(() => elFor(activeABRef.current), [elFor]);

  /** Set the perceptual volume — via userGain once the graph exists, else element.volume as a fallback. */
  const applyVolume = useCallback((s: number) => {
    const g = sliderToGain(s);
    if (userGainRef.current) userGainRef.current.gain.value = g;
    else if (elARef.current) elARef.current.volume = g;
  }, []);

  /** Build the Web Audio graph once. No-op if already built or Web Audio is unavailable. */
  const ensureGraph = useCallback(() => {
    if (audioCtxRef.current || !elARef.current || !elBRef.current) return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // Web Audio unavailable — element.volume keeps working (single element)
    try {
      const ctx = new Ctor();
      const eqLow = ctx.createBiquadFilter();
      eqLow.type = 'lowshelf';
      eqLow.frequency.value = 120;
      const eqMid = ctx.createBiquadFilter();
      eqMid.type = 'peaking';
      eqMid.frequency.value = 1500;
      eqMid.Q.value = 1;
      const eqHigh = ctx.createBiquadFilter();
      eqHigh.type = 'highshelf';
      eqHigh.frequency.value = 6000;
      const comp = ctx.createDynamicsCompressor();
      const makeup = ctx.createGain();
      const userGain = ctx.createGain();
      // per-element: el → src → rg → fade → eqLow (both fades sum into the shared chain)
      const srcA = ctx.createMediaElementSource(elARef.current);
      const rgA = ctx.createGain();
      const fadeA = ctx.createGain();
      srcA.connect(rgA).connect(fadeA).connect(eqLow);
      const srcB = ctx.createMediaElementSource(elBRef.current);
      const rgB = ctx.createGain();
      const fadeB = ctx.createGain();
      srcB.connect(rgB).connect(fadeB).connect(eqLow);
      // shared chain: EQ → dynamics → makeup → master volume → out
      eqLow.connect(eqMid).connect(eqHigh).connect(comp).connect(makeup).connect(userGain).connect(ctx.destination);
      rgA.gain.value = 1;
      rgB.gain.value = 1;
      fadeA.gain.value = activeABRef.current === 'a' ? 1 : 0;
      fadeB.gain.value = activeABRef.current === 'b' ? 1 : 0;
      userGain.gain.value = sliderToGain(volumeRef.current);
      applyEq(eqLow, eqMid, eqHigh, eqPresetRef.current);
      applyNight(comp, makeup, nightModeRef.current);
      elARef.current.volume = 1; // all volume now flows through userGain
      elBRef.current.volume = 1;
      audioCtxRef.current = ctx;
      srcARef.current = srcA;
      srcBRef.current = srcB;
      rgARef.current = rgA;
      rgBRef.current = rgB;
      fadeARef.current = fadeA;
      fadeBRef.current = fadeB;
      eqLowRef.current = eqLow;
      eqMidRef.current = eqMid;
      eqHighRef.current = eqHigh;
      compRef.current = comp;
      makeupRef.current = makeup;
      userGainRef.current = userGain;
      const sink = outputIdRef.current;
      if (canPickOutput && sink && sink !== 'default') {
        void (ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(sink).catch(() => {});
      }
      if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
        (window as unknown as { __sommAudio?: unknown }).__sommAudio = {
          ctx, rgA, rgB, fadeA, fadeB, eqLow, eqMid, eqHigh, comp, makeup, userGain,
          active: () => activeABRef.current,
        };
      }
    } catch {
      /* graph build failed — leave element.volume in charge */
    }
  }, [canPickOutput]);

  /** Build + resume the graph. Must run from a user gesture (autoplay policy suspends the context). */
  const kick = useCallback(() => {
    ensureGraph();
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }, [ensureGraph]);

  /** Fetch a track's ReplayGain and apply it to one side's rg node (and the indicator if that side is active). */
  const applyRgTo = useCallback(
    async (ab: AB, track: PlayerTrack) => {
      const rg = rgFor(ab);
      const el = elFor(ab);
      if (!rg || !el) return;
      const url = audioUrl(track.path);
      let r;
      try {
        r = await api.loudness(track.path);
      } catch {
        return;
      }
      if (el.getAttribute('src') !== url) return; // element was reused for another track meanwhile
      const q = queueRef.current;
      const albumMode = !!track.albumId && q.length > 0 && q.every((t) => t.albumId === track.albumId);
      const effDb = effectiveGainDb(r, albumMode);
      rg.gain.value = effDb == null ? 1 : 10 ** (effDb / 20);
      if (activeABRef.current === ab) setNormalizationDb(effDb);
    },
    [rgFor, elFor],
  );

  /** Point one side's element at a track (and apply its ReplayGain). Optionally start playing it. */
  const loadInto = useCallback(
    (ab: AB, track: PlayerTrack, opts: { play: boolean }) => {
      const el = elFor(ab);
      if (!el) return;
      const rg = rgFor(ab);
      if (rg) rg.gain.value = 1; // reset to 0 dB until this track's RG resolves
      el.src = audioUrl(track.path);
      el.load();
      void applyRgTo(ab, track);
      if (opts.play) void el.play().catch(() => {});
    },
    [elFor, rgFor, applyRgTo],
  );

  /** Abort an in-progress crossfade and restore active=1 / inactive=0 (used by manual transport). */
  const cancelCrossfade = useCallback(() => {
    if (crossfadeTimerRef.current) {
      clearTimeout(crossfadeTimerRef.current);
      crossfadeTimerRef.current = null;
    }
    if (!crossfadingRef.current) return;
    crossfadingRef.current = false;
    const ctx = audioCtxRef.current;
    const act = activeABRef.current;
    const inAb: AB = act === 'a' ? 'b' : 'a';
    const af = fadeFor(act);
    const bf = fadeFor(inAb);
    if (ctx && af && bf) {
      af.gain.cancelScheduledValues(ctx.currentTime);
      bf.gain.cancelScheduledValues(ctx.currentTime);
    }
    if (af) af.gain.value = 1;
    if (bf) bf.gain.value = 0;
    const inEl = elFor(inAb);
    if (inEl) inEl.pause();
  }, [fadeFor, elFor]);

  const playQueue = useCallback(
    (tracks: PlayerTrack[], startIndex: number) => {
      if (tracks.length === 0) return;
      kick(); // build/resume the audio graph within this user gesture
      cancelCrossfade();
      setAutoDj(null); // manually choosing what to play exits Auto DJ
      setQueue(tracks);
      setIndex(Math.max(0, Math.min(startIndex, tracks.length - 1)));
      setError(null);
    },
    [kick, cancelCrossfade],
  );

  const startAutoDj = useCallback(
    async (seed: AutoDjSeed) => {
      kick(); // build/resume the audio graph within this user gesture
      cancelCrossfade();
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
    },
    [kick, cancelCrossfade],
  );

  const stopAutoDj = useCallback(() => setAutoDj(null), []);

  const setEqPreset = useCallback((p: EqPreset) => {
    setEqPresetState(p);
    try {
      localStorage.setItem('somm.eq', p);
    } catch {
      /* ignore */
    }
    if (eqLowRef.current && eqMidRef.current && eqHighRef.current) {
      applyEq(eqLowRef.current, eqMidRef.current, eqHighRef.current, p);
    }
  }, []);

  const setNightMode = useCallback((on: boolean) => {
    setNightModeState(on);
    try {
      localStorage.setItem('somm.night', on ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (compRef.current && makeupRef.current) applyNight(compRef.current, makeupRef.current, on);
  }, []);

  const setCrossfadeSec = useCallback((s: number) => {
    const v = (CROSSFADE_OPTIONS as readonly number[]).includes(s) ? s : 0;
    setCrossfadeSecState(v);
    try {
      localStorage.setItem('somm.xfade', String(v));
    } catch {
      /* ignore */
    }
  }, []);

  const refreshOutputs = useCallback(async () => {
    if (!canPickOutput || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const outs = devs
        .filter((d) => d.kind === 'audiooutput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Output ${i + 1}` }));
      setOutputs(outs);
    } catch {
      /* enumerate blocked — leave the list empty (System default still works) */
    }
  }, [canPickOutput]);

  const setOutputId = useCallback(async (id: string) => {
    setOutputIdState(id);
    try {
      localStorage.setItem('somm.sink', id);
    } catch {
      /* ignore */
    }
    const ctx = audioCtxRef.current as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (ctx?.setSinkId) {
      try {
        await ctx.setSinkId(id === 'default' ? '' : id); // '' = system default
      } catch {
        /* device unplugged / not allowed — stays on the previous sink */
      }
    }
  }, []);

  const next = useCallback(() => {
    cancelCrossfade();
    setIndex((i) => Math.min(i + 1, queueLenRef.current - 1));
  }, [cancelCrossfade]);
  const prev = useCallback(() => {
    cancelCrossfade();
    setIndex((i) => Math.max(i - 1, 0));
  }, [cancelCrossfade]);
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
    const a = activeEl();
    if (!a || !a.src) return;
    kick();
    if (a.paused) void a.play().catch(() => {});
    else a.pause();
  }, [kick, activeEl]);

  const seek = useCallback(
    (sec: number) => {
      cancelCrossfade();
      const a = activeEl();
      if (a && Number.isFinite(sec)) a.currentTime = sec;
    },
    [activeEl, cancelCrossfade],
  );

  const setVolume = useCallback(
    (v: number) => {
      const s = Math.min(1, Math.max(0, v));
      setVol(s);
      try {
        localStorage.setItem('somm.volume', String(s));
      } catch {
        /* private mode / quota — non-fatal */
      }
      applyVolume(s);
    },
    [applyVolume],
  );

  /** Two tracks are an album "seam" (kept gapless, never crossfaded) when they share an album. */
  const isSeam = (a: PlayerTrack | undefined, b: PlayerTrack | undefined) =>
    !!a?.albumId && a.albumId === b?.albumId;

  /** Begin an equal-power crossfade from the active element to the preloaded inactive one. */
  const startCrossfade = useCallback(
    (xf: number) => {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const fromAB = activeABRef.current;
      const toAB: AB = fromAB === 'a' ? 'b' : 'a';
      const fromEl = elFor(fromAB);
      const toEl = elFor(toAB);
      const fromFade = fadeFor(fromAB);
      const toFade = fadeFor(toAB);
      const i = indexRef.current;
      const nxt = queueRef.current[i + 1];
      if (!fromEl || !toEl || !fromFade || !toFade || !nxt) return;
      // ensure the incoming element holds the next track (the preload effect normally did this already)
      if (toEl.getAttribute('src') !== audioUrl(nxt.path)) loadInto(toAB, nxt, { play: false });
      crossfadingRef.current = true;
      try {
        toEl.currentTime = 0;
      } catch {
        /* not seekable yet — fine */
      }
      void toEl.play().catch(() => {});
      const t0 = ctx.currentTime;
      const steps = 24;
      fromFade.gain.cancelScheduledValues(t0);
      toFade.gain.cancelScheduledValues(t0);
      fromFade.gain.setValueAtTime(fromFade.gain.value, t0);
      toFade.gain.setValueAtTime(toFade.gain.value, t0);
      for (let k = 1; k <= steps; k++) {
        const tt = k / steps;
        fromFade.gain.linearRampToValueAtTime(Math.cos((tt * Math.PI) / 2), t0 + tt * xf); // equal-power out
        toFade.gain.linearRampToValueAtTime(Math.cos(((1 - tt) * Math.PI) / 2), t0 + tt * xf); // equal-power in
      }
      crossfadeTimerRef.current = setTimeout(() => {
        crossfadeTimerRef.current = null;
        if (!crossfadingRef.current) return;
        fromEl.pause();
        fromFade.gain.value = 0;
        toFade.gain.value = 1;
        activeABRef.current = toAB;
        crossfadingRef.current = false;
        setIsPlaying(!toEl.paused);
        setIndex((x) => (x === i ? i + 1 : x)); // promote; the load effect sees the element already loaded
      }, xf * 1000 + 60);
    },
    [elFor, fadeFor, loadInto],
  );

  /** Called from the active element's timeupdate: start a crossfade as the track nears its end. */
  const maybeCrossfade = useCallback(
    (el: HTMLAudioElement) => {
      const xf = crossfadeSecRef.current;
      if (xf <= 0 || crossfadingRef.current || el.paused) return;
      const i = indexRef.current;
      const q = queueRef.current;
      const cur = q[i];
      const nxt = q[i + 1];
      if (!cur || !nxt || isSeam(cur, nxt)) return; // no next, or album seam → let it play out gaplessly
      const dur = el.duration;
      if (!Number.isFinite(dur) || dur <= 0) return;
      if (dur - el.currentTime > xf) return;
      startCrossfade(Math.min(xf, dur)); // never fade longer than the track
    },
    [startCrossfade],
  );

  // Load + play whenever the active track changes (keyed on path so re-renders don't reload). If the active
  // element already holds this track (a crossfade just promoted it), don't reload — just sync state.
  useEffect(() => {
    if (!current) return;
    kick();
    const ab = activeABRef.current;
    const el = elFor(ab);
    if (!el) return;
    const url = audioUrl(current.path);
    if (el.getAttribute('src') === url) {
      // promoted by a crossfade — already playing the right track
      if (el.paused) void el.play().catch(() => {});
      setDuration(el.duration || 0);
      setCurrentTime(el.currentTime || 0);
      void applyRgTo(ab, current); // sync the RG indicator to this (now active) side
      setError(null);
      return;
    }
    setError(null);
    setCurrentTime(0);
    setNormalizationDb(null);
    loadInto(ab, current, { play: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.path]);

  const onEnded = useCallback(
    (el: HTMLAudioElement) => {
      if (el !== activeEl() || crossfadingRef.current) return; // ignore the outgoing element after a crossfade
      setIndex((i) => {
        if (i + 1 < queueLenRef.current) return i + 1;
        if (repeatRef.current && queueLenRef.current > 0) return 0; // repeat all → loop to start
        setIsPlaying(false);
        return i;
      });
    },
    [activeEl],
  );

  // ---- element event handlers (shared by both <audio>s; gated so only the ACTIVE one drives UI state) ----
  const onPlay = useCallback((e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget === activeEl()) setIsPlaying(true);
  }, [activeEl]);
  const onPause = useCallback((e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget === activeEl()) setIsPlaying(false);
  }, [activeEl]);
  const onTimeUpdate = useCallback((e: SyntheticEvent<HTMLAudioElement>) => {
    const el = e.currentTarget;
    if (el !== activeEl()) return;
    setCurrentTime(el.currentTime);
    maybeCrossfade(el);
  }, [activeEl, maybeCrossfade]);
  const onLoadedMeta = useCallback((e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget === activeEl()) setDuration(e.currentTarget.duration || 0);
  }, [activeEl]);
  const onErr = useCallback((e: SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget !== activeEl()) return;
    setIsPlaying(false);
    const c = currentRef.current;
    setError(c ? `Can’t play “${c.title}” (unsupported format?)` : 'Playback error');
  }, [activeEl]);

  // Global keyboard transport: Space play/pause, ←/→ seek ±5s, Shift+←/→ prev/next.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = activeEl();
      if (!a || indexRef.current < 0) return;
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
        next();
      } else if (e.key === 'ArrowLeft' && e.shiftKey) {
        e.preventDefault();
        prev();
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
  }, [kick, activeEl, next, prev]);

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

  // Preload the next track into the INACTIVE element (paused) so advancing — and crossfade — are instant.
  useEffect(() => {
    const ab: AB = activeABRef.current === 'a' ? 'b' : 'a';
    const el = elFor(ab);
    if (!el) return;
    const nxt = index >= 0 && index + 1 < queue.length ? queue[index + 1] : null;
    if (!nxt) return;
    if (el.getAttribute('src') === audioUrl(nxt.path)) return; // already warming this track
    loadInto(ab, nxt, { play: false });
  }, [index, queue, elFor, loadInto]);

  // Defensive teardown: clear a pending crossfade finalize timer on unmount. (The provider is a root
  // singleton in practice, so this rarely fires; we intentionally do NOT close the AudioContext — that
  // would break React StrictMode's mount/unmount/mount cycle, which reuses the already-built graph.)
  useEffect(() => () => {
    if (crossfadeTimerRef.current) clearTimeout(crossfadeTimerRef.current);
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
      eqPreset,
      setEqPreset,
      nightMode,
      setNightMode,
      crossfadeSec,
      setCrossfadeSec,
      outputs,
      outputId,
      setOutputId,
      refreshOutputs,
      canPickOutput,
    }),
    [queue, index, current, isPlaying, currentTime, duration, volume, normalizationDb, error, playQueue, toggle, next, prev, seek, setVolume, repeat, toggleRepeat, shuffle, autoDj, startAutoDj, stopAutoDj, eqPreset, setEqPreset, nightMode, setNightMode, crossfadeSec, setCrossfadeSec, outputs, outputId, setOutputId, refreshOutputs, canPickOutput],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Two elements so we can crossfade; both routed through the Web Audio graph. */}
      <audio
        ref={elARef}
        preload="auto"
        onPlay={onPlay}
        onPause={onPause}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMeta}
        onEnded={(e) => onEnded(e.currentTarget)}
        onError={onErr}
      />
      <audio
        ref={elBRef}
        preload="auto"
        onPlay={onPlay}
        onPause={onPause}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMeta}
        onEnded={(e) => onEnded(e.currentTarget)}
        onError={onErr}
      />
    </Ctx.Provider>
  );
}
