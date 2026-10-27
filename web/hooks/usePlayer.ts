'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { isIOSDevice } from '@/lib/platform';
import { useStationOrigin } from '@/lib/stationOrigin';
import { withStreamAuth } from '@/lib/stationAuth';
import { loadVolumePref, saveVolumePref } from '@/lib/volume';
import { playErrorClass, radioDiagnostic } from '@/lib/radioDiagnostics';
import { isCurrentPlayGeneration, mediaClockAdvancedForAttempt, mediaEventBelongsToAttempt } from '@/lib/mediaAttemptEvidence';

// Reconnect backoff for the watchdog's error path: quick first retry, doubling to a minute.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 60_000;

// Idle cutoff (#343). A forgotten tab counts as a listener and holds the DJ's
// pause-when-empty gate open, so tune out after this long with no pointer/key/focus activity.
const IDLE_TUNE_OUT_MS = 8 * 60 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60_000;

// HTMLMediaElement.HAVE_FUTURE_DATA, read as a constant so the checks below work on a detached element.
const HAVE_FUTURE_DATA = 3;

// Ground truth for "the listener is hearing sound": `stalled` says nothing about
// it, and a wedged element fails this check even though `paused` is false.
function advancingSince(el: HTMLAudioElement, since: number): boolean {
  return !el.paused && el.readyState >= HAVE_FUTURE_DATA && el.currentTime > since;
}

export type PlayerStatus = 'idle' | 'connecting' | 'playing';

export interface Player {
  audioRef: RefObject<HTMLAudioElement | null>;
  audioElement: HTMLAudioElement | null;
  mediaSourceRevision: number;
  /** Ref callback the consumer MUST put on its <audio> element instead of audioRef:
   *  it keeps audioRef on the live node AND tells the hook when that node is replaced
   *  so the media listeners re-attach (#1232). Stable identity. */
  attachAudio: (el: HTMLAudioElement | null) => void;
  tunedIn: boolean;
  status: PlayerStatus;
  /** Source-correlated status for the startup console; does not drive playback. */
  attemptMediaStatus: PlayerStatus | 'error';
  volume: number;
  setVolume: Dispatch<SetStateAction<number>>;
  tune: () => void;
  stop: () => void;
  toggleMute: () => void;
  muted: boolean;
  // True when the idle cutoff, not the listener, tore playback down. Cleared on the next tune().
  idleStopped: boolean;
  attemptId: number;
  attemptStartedAt: number | null;
  attemptStartedIdle: boolean;
  clockAdvanced: boolean;
  mediaWaiting: boolean;
  playFailure: string | null;
}

export interface UsePlayerOptions {
  initialVolume?: number;
  /** Whether the station is configured to serve `/stream.opus` (the setting, not a
   *  live mount probe). null/undefined = not known yet; the upgrade waits. */
  opusEnabled?: boolean | null;
  /** Last reported station idle-gate state, captured only at intentional Tune In. */
  streamIdle?: boolean;
}

// Owns the <audio> element + tune-in state. The consumer renders the <audio> tag, so skins can tap it.
export function usePlayer({ initialVolume = 1, opusEnabled = null, streamIdle = false }: UsePlayerOptions = {}): Player {
  const { streams } = useStationOrigin();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // audioRef.current mirrored into state so the listener effect can depend on it:
  // refs don't notify on attach, so a swapped element has to announce itself.
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const [mediaSourceRevision, setMediaSourceRevision] = useState(0);
  const attachAudio = useCallback((el: HTMLAudioElement | null) => {
    audioRef.current = el;
    setAudioEl(el);
  }, []);
  // SSR + first render use the MP3 URL so markup agrees; the effect below upgrades to Opus.
  const [streamUrl, setStreamUrl] = useState<string>(streams.mp3);
  const [tunedIn, setTunedIn] = useState(false);
  // 'connecting' covers the gap between the tune-in gesture and the first audible frames.
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [attemptMediaStatus, setAttemptMediaStatus] = useState<PlayerStatus | 'error'>('idle');
  const [volume, setVolume] = useState(initialVolume);
  const [idleStopped, setIdleStopped] = useState(false);
  const [attemptId, setAttemptId] = useState(0);
  const [attemptStartedAt, setAttemptStartedAt] = useState<number | null>(null);
  const [attemptStartedIdle, setAttemptStartedIdle] = useState(false);
  const [clockAdvanced, setClockAdvanced] = useState(false);
  const [mediaWaiting, setMediaWaiting] = useState(false);
  const [playFailure, setPlayFailure] = useState<string | null>(null);
  const preMuteVolume = useRef(initialVolume || 1);

  // play() resolves async and pausing before it settles rejects with AbortError. The latest
  // promise plus a generation counter let rapid tune/stop toggles settle on the last action.
  const playPromise = useRef<Promise<void> | null>(null);
  const gen = useRef(0);

  // Refs mirror the latest state the stall watchdog reads, so its listeners register once.
  const tunedInRef = useRef(tunedIn);
  const streamUrlRef = useRef(streamUrl);
  const streamsRef = useRef(streams);
  const volumeRef = useRef(volume);
  const streamIdleRef = useRef(streamIdle);
  streamIdleRef.current = streamIdle;
  const watchdogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Media clock at arm time — the baseline the fire compares against.
  const watchdogArmedAt = useRef(0);
  // Consecutive failed reconnects since the last 'playing'; drives the backoff.
  const retryCount = useRef(0);
  // Last listener activity, read by the idle sweep. Seeded by the sweep effect at mount
  // (render must stay pure) so a fresh tab gets the full idle window.
  const lastActivityAt = useRef(0);
  // The idle sweep mounts once but must call the latest stop() — bridge with a ref.
  const stopRef = useRef<() => void>(() => {});
  // Set if the optional Opus mount fails to load; pins to MP3 so the watchdog stops retrying.
  const opusFailedRef = useRef(false);
  const attemptRef = useRef(0);
  const clockStartRef = useRef(0);
  const clockReportedRef = useRef(false);
  const expectedMediaSourceRef = useRef<string | null>(null);
  const previousMediaElementRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => { tunedInRef.current = tunedIn; }, [tunedIn]);
  useEffect(() => { streamUrlRef.current = streamUrl; }, [streamUrl]);
  useEffect(() => { streamsRef.current = streams; }, [streams]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // Restore the listener's last-used volume (#783). Effect-only, so SSR and first paint
  // stay on the default; `hydrated` keeps it from racing the persist effect below.
  const hydratedRef = useRef(false);
  useEffect(() => {
    const stored = loadVolumePref();
    if (stored !== null) {
      setVolume(stored);
      preMuteVolume.current = stored > 0 ? stored : preMuteVolume.current;
    }
    hydratedRef.current = true;
  }, []);

  // Debounced so a knob drag collapses to one write. The cleanup also keeps the mount
  // pass's default from reaching localStorage before the restore effect's setVolume lands.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const id = setTimeout(() => saveVolumePref(volume), 300);
    return () => clearTimeout(id);
  }, [volume]);

  // Four gates guard the Opus upgrade; MP3 is the universal floor. Require
  // canPlayType 'probably', skip the iOS family and skip Firefox by UA (both
  // choke on Icecast's chained Ogg at a crossfade, #212), and require the
  // station's own `opusEnabled` to be explicitly true (null = not polled yet).
  // That is the SETTING and the mixer reads it at startup, so a saved-but-not-
  // restarted station can still 404 -- hence the onError self-heal below. No
  // live retarget: setStreamUrl reaches the element only on the next
  // tune()/reconnect() (#1232, #1234).
  useEffect(() => {
    if (opusEnabled !== true) return;
    if (!streams.opus || opusFailedRef.current) return;
    const ua = navigator.userAgent;
    // Desktop/Android Firefox + Gecko forks carry "Firefox" in the UA; Firefox-for-iOS
    // reports "FxiOS" and is already caught by isIOSDevice() below.
    const isFirefox = /firefox/i.test(ua);
    if (isIOSDevice() || isFirefox) return;
    const tester = document.createElement('audio');
    const opusOk = tester.canPlayType('audio/ogg; codecs=opus');
    if (opusOk === 'probably') {
      setStreamUrl(streams.opus);
    }
  }, [streams.opus, opusEnabled]);

  // Drive `status` from the <audio> element's own events and reconnect when it
  // wedges. 'playing' clears the watchdog; 'waiting'/'stalled' arm a 5s timer
  // that re-sets src if the media clock hasn't moved; 'error' and 'ended'
  // reconnect with backoff. A live Icecast mount can report a network reset as
  // 'ended' without an 'error', so that event is part of the recovery path too.
  useEffect(() => {
    const el = audioEl;
    if (!el) return;
    const previousElement = previousMediaElementRef.current;
    previousMediaElementRef.current = el;
    if (previousElement && previousElement !== el && tunedInRef.current) {
      // A remounted audio node has not proven progress for the current source.
      // Clear only the UI evidence; the playback/reconnect owner is unchanged.
      setClockAdvanced(false);
      setMediaWaiting(false);
      setAttemptMediaStatus('connecting');
    }

    const clearWatchdog = () => {
      if (watchdogTimer.current !== null) {
        clearTimeout(watchdogTimer.current);
        watchdogTimer.current = null;
      }
    };

    const reconnect = () => {
      clearWatchdog();
      if (!tunedInRef.current || !audioRef.current) return;
      const audio = audioRef.current;
      // The media clock moved while the watchdog was pending, so the listener is hearing
      // audio. Re-setting src would cut sound for nothing; reconcile the UI instead (#1232).
      if (advancingSince(audio, watchdogArmedAt.current)) {
        retryCount.current = 0;
        setStatus('playing');
        return;
      }
      const myGen = ++gen.current;
      audio.src = withStreamAuth(`${streamUrlRef.current}?t=${Date.now()}`);
      setMediaSourceRevision(revision => revision + 1);
      expectedMediaSourceRef.current = audio.src;
      clockStartRef.current = 0;
      clockReportedRef.current = false;
      setClockAdvanced(false);
      setMediaWaiting(false);
      setAttemptMediaStatus('connecting');
      audio.volume = volumeRef.current;
      setStatus('connecting');
      const p = audio.play();
      playPromise.current = p;
      Promise.resolve(p).catch((err: unknown) => {
        const name = err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : undefined;
        if (isCurrentPlayGeneration(myGen, gen.current) && name !== 'AbortError') {
          console.error('Reconnect failed:', err);
        }
      });
    };

    const armWatchdog = (delay: number) => {
      if (!tunedInRef.current) return;
      clearWatchdog();
      // Sample the media clock so the fire can tell a dead stream from late bytes.
      watchdogArmedAt.current = audioRef.current?.currentTime ?? 0;
      watchdogTimer.current = setTimeout(reconnect, delay);
    };

    const onPlaying = () => {
      const belongs = mediaEventBelongsToAttempt(expectedMediaSourceRef.current, el.currentSrc);
      if (belongs) radioDiagnostic(attemptRef.current, 'playing-event');
      clearWatchdog();
      retryCount.current = 0;
      if (belongs) {
        setMediaWaiting(false);
        setAttemptMediaStatus('playing');
      }
      setStatus('playing');
    };
    // 'waiting' is a PLAYBACK event: the element ran out of decoded audio and has gone silent.
    const onWaiting = () => {
      if (mediaEventBelongsToAttempt(expectedMediaSourceRef.current, el.currentSrc)) {
        radioDiagnostic(attemptRef.current, 'waiting');
        setMediaWaiting(true);
        setAttemptMediaStatus('connecting');
      }
      setStatus(s => (s === 'playing' ? 'connecting' : s));
      armWatchdog(5000);
    };
    // 'stalled' is a NETWORK event (no bytes for ~3s) and fires routinely on a
    // live mount while playback continues from buffer, so no second 'playing' is
    // coming. Arm the watchdog only (#1232).
    const onStalled = () => {
      if (mediaEventBelongsToAttempt(expectedMediaSourceRef.current, el.currentSrc)) {
      radioDiagnostic(attemptRef.current, 'stalled');
      setMediaWaiting(true);
      }
      armWatchdog(5000);
    };
    const onLoadStart = () => {
      if (mediaEventBelongsToAttempt(expectedMediaSourceRef.current, el.currentSrc)) {
        radioDiagnostic(attemptRef.current, 'loadstart');
      }
    };
    const onCanPlay = () => {
      if (mediaEventBelongsToAttempt(expectedMediaSourceRef.current, el.currentSrc)) {
        radioDiagnostic(attemptRef.current, 'canplay');
        setMediaWaiting(false);
      }
    };
    // timeupdate fires only while the clock actually moves, so it reconciles a status left
    // on 'connecting' by event sequences the handlers above don't model.
    const onTimeUpdate = () => {
      if (el.paused || el.readyState < HAVE_FUTURE_DATA) return;
      const advanced = mediaClockAdvancedForAttempt({
        expectedSource: expectedMediaSourceRef.current,
        eventSource: el.currentSrc,
        currentTime: el.currentTime,
        baseline: clockStartRef.current,
      });
      if (advanced) setMediaWaiting(false);
      if (!clockReportedRef.current && advanced) {
        clockReportedRef.current = true;
        setClockAdvanced(true);
        setAttemptMediaStatus('playing');
        radioDiagnostic(attemptRef.current, 'clock-advanced', { mediaTime: Number(el.currentTime.toFixed(3)) });
      }
      setStatus(s => (s === 'connecting' ? 'playing' : s));
    };
    const onError = () => {
      if (mediaEventBelongsToAttempt(expectedMediaSourceRef.current, el.currentSrc)) {
        radioDiagnostic(attemptRef.current, 'media-error', { mediaErrorCode: el.error?.code ?? null });
        setMediaWaiting(false);
        setAttemptMediaStatus('error');
      }
      setStatus('idle');
      // A failing Opus mount (commonly a 404 when Opus is off server-side) falls back
      // permanently to MP3 rather than reconnecting to the dead URL on every retry.
      const { mp3, opus } = streamsRef.current;
      if (opus && streamUrlRef.current === opus) {
        opusFailedRef.current = true;
        streamUrlRef.current = mp3;
        setStreamUrl(mp3);
      }
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** retryCount.current, RECONNECT_MAX_MS);
      retryCount.current += 1;
      armWatchdog(delay);
    };
    const onEnded = () => {
      if (!tunedInRef.current) return;
      if (mediaEventBelongsToAttempt(expectedMediaSourceRef.current, el.currentSrc)) {
        setAttemptMediaStatus('connecting');
        setMediaWaiting(false);
      }
      setStatus('connecting');
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** retryCount.current, RECONNECT_MAX_MS);
      retryCount.current += 1;
      armWatchdog(delay);
    };
    el.addEventListener('playing', onPlaying);
    el.addEventListener('loadstart', onLoadStart);
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('stalled', onStalled);
    el.addEventListener('canplay', onCanPlay);
    el.addEventListener('timeupdate', onTimeUpdate);
    el.addEventListener('error', onError);
    el.addEventListener('ended', onEnded);
    return () => {
      clearWatchdog();
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('loadstart', onLoadStart);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('stalled', onStalled);
      el.removeEventListener('canplay', onCanPlay);
      el.removeEventListener('timeupdate', onTimeUpdate);
      el.removeEventListener('error', onError);
      el.removeEventListener('ended', onEnded);
    };
  }, [audioEl]);

  useEffect(() => {
    if (tunedIn && attemptRef.current > 0) {
      radioDiagnostic(attemptRef.current, 'ui-feedback', { tunedIn, status });
    }
  }, [tunedIn, status]);

  // Idle cutoff (#343): a tab with no activity for IDLE_TUNE_OUT_MS is tuned out
  // so it doesn't sit on the mount as a phantom listener. Sweeps once a minute.
  useEffect(() => {
    const markActivity = () => { lastActivityAt.current = Date.now(); };
    markActivity(); // seed: mount counts as the start of the idle window
    const onVisibility = () => {
      if (document.visibilityState === 'visible') markActivity();
    };
    window.addEventListener('pointerdown', markActivity);
    window.addEventListener('keydown', markActivity);
    document.addEventListener('visibilitychange', onVisibility);
    const sweep = setInterval(() => {
      if (!tunedInRef.current) return;
      if (Date.now() - lastActivityAt.current < IDLE_TUNE_OUT_MS) return;
      setIdleStopped(true);
      stopRef.current();
    }, IDLE_CHECK_INTERVAL_MS);
    return () => {
      clearInterval(sweep);
      window.removeEventListener('pointerdown', markActivity);
      window.removeEventListener('keydown', markActivity);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Tear down playback. Also called by PlayerApp when the station goes off air.
  const stop = () => {
    if (!audioRef.current) return;
    const el = audioRef.current;
    const myGen = ++gen.current;
    if (watchdogTimer.current !== null) {
      clearTimeout(watchdogTimer.current);
      watchdogTimer.current = null;
    }
    setTunedIn(false);
    setStatus('idle');
    setAttemptMediaStatus('idle');
    setMediaWaiting(false);
    setPlayFailure(null);
    expectedMediaSourceRef.current = null;
    setAttemptStartedIdle(false);
    // Let any in-flight play() settle before pausing, then bail if a later tune() superseded this.
    Promise.resolve(playPromise.current)
      .catch(() => {})
      .then(() => {
        if (gen.current !== myGen) return;
        el.pause();
        el.src = '';
      });
  };
  stopRef.current = stop;

  const tune = () => {
    if (!audioRef.current) return;
    if (tunedIn) {
      stop();
      return;
    }
    const el = audioRef.current;
    const myGen = ++gen.current;
    const attempt = ++attemptRef.current;
    const startedAt = performance.now();
    setAttemptId(attempt);
    setAttemptStartedAt(startedAt);
    setAttemptStartedIdle(streamIdleRef.current);
    setClockAdvanced(false);
    setMediaWaiting(false);
    setAttemptMediaStatus('connecting');
    setPlayFailure(null);
    clockReportedRef.current = false;
    radioDiagnostic(attempt, 'tune-gesture');
    // A fresh tune-in is listener activity: restart the idle window, clear the idle prompt, reset backoff.
    lastActivityAt.current = Date.now();
    setIdleStopped(false);
    retryCount.current = 0;
    el.src = withStreamAuth(`${streamUrl}?t=${Date.now()}`);
    setMediaSourceRevision(revision => revision + 1);
    expectedMediaSourceRef.current = el.src;
    // A newly assigned live stream has a new media timeline beginning at zero.
    clockStartRef.current = 0;
    el.volume = volume;
    setTunedIn(true);
    setStatus('connecting');
    radioDiagnostic(attempt, 'media-play-called');
    const p = el.play();
    playPromise.current = p;
    Promise.resolve(p).then(() => {
      if (isCurrentPlayGeneration(myGen, gen.current)) radioDiagnostic(attempt, 'play-resolved');
    }).catch((err: unknown) => {
      // AbortError just means a later stop() interrupted this play — benign.
      const name = err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : undefined;
      if (isCurrentPlayGeneration(myGen, gen.current) && name !== 'AbortError') {
        const errorClass = playErrorClass(err);
        setPlayFailure(errorClass);
        radioDiagnostic(attempt, 'play-rejected', { errorClass });
        console.error('Play failed:', err);
      }
    });
  };

  // Mute is volume 0; toggling restores the last non-zero level.
  const toggleMute = () => {
    if (volume > 0) {
      preMuteVolume.current = volume;
      setVolume(0);
    } else {
      setVolume(preMuteVolume.current || 1);
    }
  };

  return { audioRef, audioElement: audioEl, mediaSourceRevision, attachAudio, tunedIn, status, attemptMediaStatus, volume, setVolume, tune, stop, toggleMute, muted: volume === 0, idleStopped, attemptId, attemptStartedAt, attemptStartedIdle, clockAdvanced, mediaWaiting, playFailure };
}
