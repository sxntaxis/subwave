'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useInterval } from 'usehooks-ts';
import { isIOSDevice } from './platform';
import { mediaEventBelongsToAttempt } from './mediaAttemptEvidence';
import {
  EMPTY_AUDIO_SIGNAL_EVIDENCE,
  observeAudioSignal,
  rmsDbfs,
  type AudioSignalEvidence,
} from './audioSignalEvidence';
import { playErrorClass, radioDiagnostic } from './radioDiagnostics';

// SSR-safe iOS flag: false on the server and first client render, real value
// after mount. For branching UI that can't work on iOS (issue #298).
export function useIsIOS(): boolean {
  const [ios, setIos] = useState(false);
  useEffect(() => { setIos(isIOSDevice()); }, []);
  return ios;
}

// Null until mount, same SSR reason as useIsIOS. First tick on mount, then
// useInterval owns the cadence.
export function useClock(): Date | null {
  const [t, setT] = useState<Date | null>(null);
  useEffect(() => { setT(new Date()); }, []);
  useInterval(() => setT(new Date()), 1000);
  return t;
}

export interface Analyser {
  ready: boolean;
  read: () => Uint8Array<ArrayBuffer> | null;
  /** Null until the graph exists. Callers mapping bins to frequencies need it:
   *  44.1k vs 48k shifts every bin. */
  sampleRate: number | null;
}

// Older Safari exposes AudioContext as webkitAudioContext.
type AudioContextCtor = typeof AudioContext;
interface WebkitWindow {
  webkitAudioContext?: AudioContextCtor;
}

interface ElementAudioGraph {
  ctx: AudioContext;
  analyser: AnalyserNode;
}

// One Web Audio graph per media element, for the lifetime of the page.
// createMediaElementSource captures the element permanently — a second call
// throws and a teardown mutes playback — so a later hook instance must reuse
// the first graph rather than re-capture the shared <audio>.
const ELEMENT_GRAPHS = new WeakMap<HTMLMediaElement, ElementAudioGraph>();

/** Existing graph for the element, or a freshly built one. Returns null when
 *  Web Audio is unavailable; throws (after closing the orphan context) when
 *  capture fails, so callers keep their not-ready fallback path. */
function getOrCreateElementGraph(audioEl: HTMLMediaElement): ElementAudioGraph | null {
  const existing = ELEMENT_GRAPHS.get(audioEl);
  if (existing) return existing;
  const AC: AudioContextCtor | undefined =
    window.AudioContext || (window as Window & WebkitWindow).webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  try {
    const source = ctx.createMediaElementSource(audioEl);
    const analyser = ctx.createAnalyser();
    // 4096-point FFT (2048 bins): the log-frequency sweep needs low-end
    // resolution; at 1024 the bottom octave collapses into one ~47 Hz bin.
    analyser.fftSize = 4096;
    // Only smoothing layer; higher values trail the beat against the CSS transitions.
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const graph: ElementAudioGraph = { ctx, analyser };
    ELEMENT_GRAPHS.set(audioEl, graph);
    return graph;
  } catch (err) {
    // Capture failed (element claimed elsewhere); don't leak an idle AudioContext.
    void ctx.close().catch(() => {});
    throw err;
  }
}

// Wires an AnalyserNode to the <audio> ref the first time `active` flips true.
// On failure `ready` stays false and `read()` returns null, so the Waveform
// falls back to its pseudo-random walk. iOS opts out entirely: the graph only
// yields zeros and routing through Web Audio breaks background playback (#298).
export function useAnalyser(
  audioRef: RefObject<HTMLAudioElement | null> | null | undefined,
  active: boolean,
): Analyser {
  const analyserRef = useRef<AnalyserNode | null>(null);
  const binsRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const probedRef = useRef(false);
  const [ready, setReadyState] = useState(false);
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  // In a ref so `read`'s identity never changes and the caller's rAF effect holds.
  const readyRef = useRef(false);
  const setReady = useCallback((v: boolean) => {
    readyRef.current = v;
    setReadyState(v);
  }, []);

  useEffect(() => {
    if (!active || !audioRef?.current) return;
    // iOS: never touch Web Audio (see hook header). Stay not-ready → fallback.
    if (isIOSDevice()) { setReady(false); return; }
    let cancelled = false;
    const audioEl = audioRef.current;
    let probeInterval: ReturnType<typeof setInterval> | null = null;
    let onPlaying: (() => void) | null = null;
    (async () => {
      try {
        const graph = getOrCreateElementGraph(audioEl);
        if (!graph) return; // no Web Audio in this browser
        analyserRef.current = graph.analyser;
        binsRef.current = new Uint8Array(graph.analyser.frequencyBinCount);
        setSampleRate(graph.ctx.sampleRate);
        if (graph.ctx.state === 'suspended') await graph.ctx.resume();
        if (cancelled) return;
        setReady(true);

    // Some non-iOS WebKit builds return zeros, but so does a legitimate quiet
    // opening. A constructed graph remains readable so later signal can recover.
        if (probedRef.current) return;
        onPlaying = () => {
          if (probedRef.current || cancelled) return;
          probedRef.current = true;
          let max = 0;
          let ticks = 0;
          probeInterval = setInterval(() => {
            if (cancelled) {
              if (probeInterval) clearInterval(probeInterval);
              probeInterval = null;
              return;
            }
            const bins = binsRef.current;
            const an = analyserRef.current;
            if (!bins || !an) return;
            an.getByteFrequencyData(bins);
            for (let i = 0; i < bins.length; i++) {
              const v = bins[i] ?? 0;
              if (v > max) max = v;
            }
            if (++ticks >= 12) {
              if (probeInterval) clearInterval(probeInterval);
              probeInterval = null;
              if (max === 0) {
                  // `ready` describes the graph, not evidence of audible signal.
                  // Consumers already treat zero bins as passive/no signal. Do
                  // not permanently suppress sampling after a silent opening.
                  setReady(true);
              }
            }
          }, 50);
        };
        audioEl.addEventListener('playing', onPlaying, { once: true });
        if (!audioEl.paused && audioEl.readyState >= 2) onPlaying();
      } catch {
        // CORS or other failure — stay not-ready
      }
    })();
    return () => {
      cancelled = true;
      if (probeInterval) clearInterval(probeInterval);
      if (onPlaying && audioEl) audioEl.removeEventListener('playing', onPlaying);
    };
  }, [active, audioRef, setReady]);

  const read = useCallback((): Uint8Array<ArrayBuffer> | null => {
    if (!readyRef.current || !analyserRef.current || !binsRef.current) return null;
    analyserRef.current.getByteFrequencyData(binsRef.current);
    return binsRef.current;
  }, []);

  return { ready, read, sampleRate };
}

export type AudioSignalProbeStatus = 'inactive' | 'sampling' | 'detected' | 'unavailable';

export interface AudioSignalProbe {
  attemptId: number;
  status: AudioSignalProbeStatus;
  contextState: AudioContext['state'] | 'interrupted' | 'unsupported' | null;
  graphCreated: boolean | null;
  failureClass: string | null;
  evidence: AudioSignalEvidence;
}

interface AudioSignalProbeOptions {
  audioEl: HTMLAudioElement | null;
  active: boolean;
  gateOpen: boolean;
  tunedIn: boolean;
  playFailure: string | null;
  attemptId: number;
  sourceRevision: number;
  attemptStartedAt: number | null;
}

const EMPTY_AUDIO_SIGNAL_PROBE: AudioSignalProbe = {
  attemptId: 0,
  status: 'inactive',
  contextState: null,
  graphCreated: null,
  failureClass: null,
  evidence: EMPTY_AUDIO_SIGNAL_EVIDENCE,
};

const AUDIO_SIGNAL_SAMPLE_INTERVAL_MS = 100;

function audioContextStateLabel(state: AudioContext['state'] | string): AudioSignalProbe['contextState'] {
  if (state === 'running' || state === 'suspended' || state === 'closed') return state;
  if (state === 'interrupted') return 'interrupted';
  return 'unsupported';
}

function safeFailureClass(error: unknown): string {
  const name = playErrorClass(error);
  return name === 'UnknownError' ? 'OtherError' : name;
}

/**
 * Short-lived, opt-in decoded-PCM probe on the player's existing element.
 * The graph is owned by ELEMENT_GRAPHS and reused if a skin has already made it.
 * Sampling is active only while the startup status is visible; no sampling loop
 * is retained after detection, gate completion, Tune Out, source change or unmount.
 */
export function useAudioSignalProbe({
  audioEl,
  active,
  gateOpen,
  tunedIn,
  playFailure,
  attemptId,
  sourceRevision,
  attemptStartedAt,
}: AudioSignalProbeOptions): AudioSignalProbe {
  const [probe, setProbe] = useState<AudioSignalProbe>(EMPTY_AUDIO_SIGNAL_PROBE);
  const latest = useRef({ active, gateOpen, tunedIn, playFailure, attemptId, sourceRevision });
  latest.current = { active, gateOpen, tunedIn, playFailure, attemptId, sourceRevision };

  useEffect(() => {
    if (!active || !audioEl || attemptId <= 0) {
      setProbe(current => current.attemptId === attemptId && current.status === 'detected'
        ? current
        : { ...EMPTY_AUDIO_SIGNAL_PROBE, attemptId });
      return;
    }

    let cancelled = false;
    let finished = false;
    let timer: number | null = null;
    let onVisibilityChange: (() => void) | null = null;
    const expectedSource = audioEl.currentSrc || audioEl.src || null;
    const graphCreated = !ELEMENT_GRAPHS.has(audioEl);
    const samples = new Float32Array(4096);
    const byteSamples = new Uint8Array(4096);
    let evidence = EMPTY_AUDIO_SIGNAL_EVIDENCE;
    let contextState: AudioSignalProbe['contextState'] = null;

    const finish = (result: 'signal-detected' | 'no-signal-before-gate' | 'unavailable' | 'cancelled', failureClass: string | null = null) => {
      if (finished) return;
      finished = true;
      if (timer != null) window.clearInterval(timer);
      timer = null;
      if (onVisibilityChange) document.removeEventListener('visibilitychange', onVisibilityChange);
      onVisibilityChange = null;
      const status: AudioSignalProbeStatus = result === 'signal-detected'
        ? 'detected'
        : result === 'unavailable' ? 'unavailable' : 'inactive';
      const finalProbe: AudioSignalProbe = {
        attemptId,
        status,
        contextState,
        graphCreated,
        failureClass,
        evidence,
      };
      setProbe(finalProbe);
      const detectionMs = evidence.detectedAtMs == null || attemptStartedAt == null
        ? null
        : evidence.detectedAtMs - attemptStartedAt;
      radioDiagnostic(attemptId, 'audio-signal-probe', {
        result,
        contextState,
        graphCreated,
        sampleCount: evidence.sampleCount,
        rmsMinDbfs: evidence.minRmsDbfs,
        rmsMaxDbfs: evidence.maxRmsDbfs,
        detectionMs,
        errorClass: failureClass,
      });
    };

    const setup = async () => {
      if (isIOSDevice()) {
        contextState = 'unsupported';
        finish('unavailable', 'NotSupportedError');
        return;
      }
      let graph: ElementAudioGraph | null;
      try {
        graph = getOrCreateElementGraph(audioEl);
      } catch (error) {
        finish('unavailable', safeFailureClass(error));
        return;
      }
      if (!graph) {
        contextState = 'unsupported';
        finish('unavailable', 'NotSupportedError');
        return;
      }
      contextState = audioContextStateLabel(graph.ctx.state);
      try {
        if (graph.ctx.state === 'suspended') await graph.ctx.resume();
      } catch (error) {
        contextState = audioContextStateLabel(graph.ctx.state);
        finish('unavailable', safeFailureClass(error));
        return;
      }
      if (cancelled) return;
      contextState = audioContextStateLabel(graph.ctx.state);
      if (graph.ctx.state !== 'running') {
        finish('unavailable', 'NotAllowedError');
        return;
      }
      setProbe({ attemptId, status: 'sampling', contextState, graphCreated, failureClass: null, evidence });
      onVisibilityChange = () => {
        if (document.visibilityState !== 'visible') {
          contextState = audioContextStateLabel(graph!.ctx.state);
          finish('unavailable', 'OtherError');
        }
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      timer = window.setInterval(() => {
        if (cancelled || finished) return;
        if (document.visibilityState !== 'visible') return;
        if (audioEl.paused || audioEl.readyState < 2) return;
        if (!mediaEventBelongsToAttempt(expectedSource, audioEl.currentSrc)) return;
        if (graph!.ctx.state !== 'running') {
          contextState = audioContextStateLabel(graph!.ctx.state);
          finish('unavailable', 'NotAllowedError');
          return;
        }
        try {
          const analyser = graph!.analyser;
          let rms: number | null;
          if (typeof analyser.getFloatTimeDomainData === 'function') {
            analyser.getFloatTimeDomainData(samples);
            rms = rmsDbfs(samples);
          } else if (typeof analyser.getByteTimeDomainData === 'function') {
            analyser.getByteTimeDomainData(byteSamples);
            for (let i = 0; i < byteSamples.length; i++) samples[i] = ((byteSamples[i] ?? 128) - 128) / 128;
            rms = rmsDbfs(samples);
          } else {
            finish('unavailable', 'NotSupportedError');
            return;
          }
          evidence = observeAudioSignal(evidence, rms, performance.now());
          if (evidence.detected) finish('signal-detected');
        } catch (error) {
          finish('unavailable', safeFailureClass(error));
        }
      }, AUDIO_SIGNAL_SAMPLE_INTERVAL_MS);
    };

    void setup().catch(error => finish('unavailable', safeFailureClass(error)));
    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
      if (!finished) {
        const current = latest.current;
        const sameAttempt = current.attemptId === attemptId && current.sourceRevision === sourceRevision;
        const completedGate = sameAttempt && current.tunedIn && !current.gateOpen && current.playFailure == null;
        const result = current.playFailure != null
          ? 'unavailable'
          : completedGate ? 'no-signal-before-gate' : 'cancelled';
        finish(result, current.playFailure);
      }
    };
  }, [active, audioEl, attemptId, attemptStartedAt, sourceRevision]);

  return probe.attemptId === attemptId ? probe : { ...EMPTY_AUDIO_SIGNAL_PROBE, attemptId };
}
