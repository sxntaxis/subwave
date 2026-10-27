'use client';

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { pollWhileVisible } from '@/lib/poll';
import { splitAudibleTurns } from '@/lib/sessionFeed';
import { createStationClock, type StationClock } from '@/lib/stationClock';
import { useStationClient } from '@/lib/stationClient';
import type {
  ActiveShow,
  DjState,
  ListenerCount,
  NowPlayingTrack,
  SessionPayload,
  StationContext,
  StationState,
  StationLocale,
  StreamInfo,
} from '@/lib/types';

export interface StationFeed {
  /** Same epoch basis as the controller's playback timestamps, advanced locally
   *  by a monotonic clock instead of the listener's wall time. */
  stationClock: StationClock;
  nowPlaying: NowPlayingTrack | null;
  context: StationContext | null;
  dj: DjState | null;
  activeShow: ActiveShow | null;
  listeners: ListenerCount | number | null;
  /** null until the first poll resolves — distinguishes "not yet known" from "offline". */
  streamOnline: boolean | null;
  /** Public stream descriptor; mount/format/bitrate describe the MP3 floor,
   *  while optional mount settings (including Opus bitrate) let a skin report
   *  the codec this browser is actually hearing. */
  stream: StreamInfo | null;
  /** Cumulative since-boot LLM token total, or null before the first poll. */
  llmTokens: number | null;
  state: StationState;
  session: SessionPayload;
  /** Effective progress origin for the current audible track, excluding idle
   *  pauses; not the original airing identity. Epoch ms, null
   *  before the first poll. Listener-time, not live-edge: it carries the
   *  `stream.bufferSeconds` offset already added and can briefly sit in the
   *  future, so useElapsed clamps at 0 (issue #1114). */
  trackStartedAt: number | null;
  /** Listener-time boundary at which progress freezes during station standby. */
  trackPausedAt: number | null;
  /** Whether the station is configured to serve `/stream.opus`, null before the
   *  first poll. The SETTING, not a live mount probe: it needs a mixer restart,
   *  so it can read true while the mount still 404s (issue #1300). */
  opusEnabled: boolean | null;
  /** Station IANA timezone, or null before the first poll. Render on-air
   *  timestamps in this zone so they match what the DJ speaks (issue #418). */
  timezone: string | null;
  locale: StationLocale;
  /** Monotonic time at which the current /state request began. Local-only, not API data. */
  stateSampleStartedAt: number;
  /** Increments only after a foreground reconciliation commits a coherent feed snapshot. */
  reconciliationId: number;
}

const EMPTY_STATE: StationState = { upcoming: [], history: [], djLog: [] };
const EMPTY_SESSION: SessionPayload = { session: null, messages: [] };
const OFFLINE_CONFIRM_POLLS = 4;

// Returning `prev` skips the re-render, so a quiet poll tick costs nothing.
// Server JSON keeps stable key order, so the stringify compare is reliable.
function setIfChanged<T>(setter: Dispatch<SetStateAction<T>>, next: T): void {
  setter(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
}

// 5s polling of /now-playing + /state + /session, paused while the tab is
// hidden (with an immediate refetch on return).
//
// The listener offset is the advertised stream.bufferSeconds. Never measure it
// as `buffered.end − currentTime`: that reports only the demuxed window (2.25s
// against a true 22.5s offset), which flips every title ~20s early.
export function useStationFeed(): StationFeed {
  const client = useStationClient();
  const [stationClock] = useState(createStationClock);
  const [nowPlaying, setNowPlaying] = useState<NowPlayingTrack | null>(null);
  const [context, setContext] = useState<StationContext | null>(null);
  const [dj, setDj] = useState<DjState | null>(null);
  const [activeShow, setActiveShow] = useState<ActiveShow | null>(null);
  const [listeners, setListeners] = useState<ListenerCount | number | null>(null);
  const [streamOnline, setStreamOnline] = useState<boolean | null>(null);
  const [stream, setStream] = useState<StreamInfo | null>(null);
  const [llmTokens, setLlmTokens] = useState<number | null>(null);
  const [state, setState] = useState<StationState>(EMPTY_STATE);
  const [session, setSession] = useState<SessionPayload>(EMPTY_SESSION);
  const [trackStartedAt, setTrackStartedAt] = useState<number | null>(null);
  const [trackPausedAt, setTrackPausedAt] = useState<number | null>(null);
  const [opusEnabled, setOpusEnabled] = useState<boolean | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [locale, setLocale] = useState<StationLocale>('en-GB');
  const [stateSampleStartedAt, setStateSampleStartedAt] = useState(0);
  const [reconciliationId, setReconciliationId] = useState(0);
  const lastTrackKeyRef = useRef<string | null>(null);
  const offlinePollsRef = useRef(0);
  // Listener buffer depth in ms. A ref, not state, so the polling effect never
  // re-subscribes when it arrives. 0 until the first payload lands, degrading
  // to live-edge behaviour rather than guessing an offset.
  const leadMsRef = useRef(0);
  // Holds a track whose metadata has arrived but whose audio hasn't reached
  // this listener yet, until it's audible.
  const promoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Same for the DJ's spoken lines (#1382), stamped with the live-edge air
  // time. Raw payload in a ref, filtered copy in state.
  const rawSessionRef = useRef<SessionPayload>(EMPTY_SESSION);
  const voiceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    stationClock.reset();
    let sessionInFlight = false;
    let inFlight = false;
    let requestSequence = 0;
    let requestController: AbortController | null = null;
    let stopped = false;
    // Re-derive the visible feed and re-arm for the next line to become
    // audible. Runs on every poll and on its own timer, so a held line lands on
    // time rather than on the 5s poll grid.
    const applySession = () => {
      const raw = rawSessionRef.current;
      // Pre-upgrade controller compatibility; after the controller starts
      // emitting serverTimeMs, this never consults the local wall clock.
      const now = stationClock.nowMs() ?? Date.now();
      const { visible, nextChangeMs } = splitAudibleTurns(raw.messages, leadMsRef.current, now);
      setIfChanged(setSession, { session: raw.session, messages: visible });
      if (voiceTimerRef.current) clearTimeout(voiceTimerRef.current);
      voiceTimerRef.current = nextChangeMs == null
        ? null
        : setTimeout(applySession, Math.max(0, nextChangeMs - (stationClock.nowMs() ?? now)));
    };
    const tick = async (reconcile = false) => {
      if (stopped || (inFlight && !reconcile)) return;
      if (reconcile) requestController?.abort();
      const controller = new AbortController();
      requestController = controller;
      const sequence = ++requestSequence;
      inFlight = true;
      try {
        // The hero only needs now-playing + state. AIR/session history is
        // deliberately fetched after those critical responses land so a slow
        // session endpoint cannot delay the first visible track by becoming the
        // slowest member of one Promise.all().
        const stateStartedAt = performance.now();
        const [{ response: npRes, receivedMono }, stRes] = await Promise.all([
          client.nowPlaying(controller.signal).then(response => ({ response, receivedMono: performance.now() })),
          client.state(controller.signal),
        ]);
        if (stopped || sequence !== requestSequence) return;
        stationClock.sample(npRes.serverTimeMs, stateStartedAt, receivedMono);
        const stationNow = stationClock.nowMs();
        // Previous controller revisions have no serverTimeMs. Keep the web
        // deploy backward-compatible until controller and web are upgraded,
        // but all fully synchronized operation uses ONLY stationClock.
        const now = stationNow ?? Date.now();
        const np = npRes.nowPlaying;
        // Clamped to 0–60s: a bad value parks the clock in the far future or
        // winds it back past the track start.
        const bufSec = npRes.stream?.bufferSeconds;
        if (typeof bufSec === 'number' && Number.isFinite(bufSec)) {
          leadMsRef.current = Math.min(Math.max(bufSec, 0), 60) * 1000;
        }
        const trackKey = np ? `${np.title}\u0000${np.artist}` : null;
        // Prefer the queue's start time over "first seen by this client": a tab
        // hidden at the transition would stamp Date.now() mid-track. Guarded to
        // the matching track and to plausible values; a server clock skewed into
        // the future falls back to first-seen.
        const cur = (stRes as StationState & { current?: { title?: string; subsonic_id?: string; startedAt?: string } }).current;
        let serverStart = NaN;
        let serverPause: number | null = null;
        if (np?.title && cur && cur.title === np.title && cur.startedAt
          && (!np.subsonic_id || !cur.subsonic_id || np.subsonic_id === cur.subsonic_id)) {
          const t = Date.parse(cur.startedAt);
          if (Number.isFinite(t) && t <= now + 1000) serverStart = t;
          const timing = stRes.playbackTiming;
          if (timing && Number.isFinite(timing.startedAt) && timing.startedAt <= now + 1000) {
            serverStart = timing.startedAt;
            if (timing.pausedAt != null && Number.isFinite(timing.pausedAt)) {
              serverPause = timing.pausedAt;
            }
          }
        }
        // Shift into listener-time: serverStart is the live edge, and the audio
        // reaches this listener leadMs later (issue #1114).
        const leadMs = leadMsRef.current;
        const audibleAt = Number.isFinite(serverStart) ? serverStart + leadMs : now;

        if (trackKey !== lastTrackKeyRef.current) {
          const commit = () => {
            promoteTimerRef.current = null;
            lastTrackKeyRef.current = trackKey;
            setTrackStartedAt(trackKey != null ? audibleAt : null);
            setTrackPausedAt(trackKey != null && serverPause != null ? serverPause + leadMs : null);
            setIfChanged(setNowPlaying, np);
          };
          const wait = audibleAt - now;
          // Promote immediately when the audio is already out (wait <= 0), when
          // the stream drops, or on the first payload (a cold load has no
          // earlier track to keep showing).
          if (wait <= 0 || trackKey == null || lastTrackKeyRef.current == null) {
            if (promoteTimerRef.current) clearTimeout(promoteTimerRef.current);
            commit();
          } else {
            // Re-armed on every poll while the switch is pending, so the wait
            // is recomputed against the freshest server stamp.
            if (promoteTimerRef.current) clearTimeout(promoteTimerRef.current);
            promoteTimerRef.current = setTimeout(commit, wait);
          }
        } else {
          setTrackPausedAt(serverPause != null ? serverPause + leadMs : null);
          if (Number.isFinite(serverStart)) {
            // A transient 2s network delay can cause the initial fallback to
            // stamp first-seen time rather than the real station start. The
            // previous ±2.5s dead zone retained that error indefinitely even
            // after healthy polls resumed. A matching authoritative timestamp
            // is stable, so correct it exactly; React skips identical values.
            setTrackStartedAt(prev => prev === audibleAt ? prev : audibleAt);
          }
          // Metadata enrichment (genres, bpm, cover) lands on later polls for a
          // track already on air, so keep taking it.
          setIfChanged(setNowPlaying, np);
        }
        // The server clock sample also refreshes voice visibility after resume.
        applySession();
        setIfChanged(setContext, npRes.context);
        if (npRes.dj) setIfChanged<DjState | null>(setDj, npRes.dj);
        setIfChanged(setActiveShow, npRes.activeShow ?? npRes.context?.activeShow ?? null);
        if (npRes.listeners != null) setIfChanged<ListenerCount | number | null>(setListeners, npRes.listeners);
        if (typeof npRes.streamOnline === 'boolean') {
          if (npRes.streamOnline) {
            offlinePollsRef.current = 0;
            setStreamOnline(true);
          } else {
            offlinePollsRef.current += 1;
            if (offlinePollsRef.current >= OFFLINE_CONFIRM_POLLS) setStreamOnline(false);
          }
        }
        // Only an explicit boolean counts: an older controller omits the key,
        // and "unknown" must not read as "on".
        if (npRes.stream) setIfChanged<StreamInfo | null>(setStream, npRes.stream);
        if (typeof npRes.stream?.opusEnabled === 'boolean') {
          setIfChanged<boolean | null>(setOpusEnabled, npRes.stream.opusEnabled);
        }
        if (typeof npRes.llmTokens === 'number') setIfChanged<number | null>(setLlmTokens, npRes.llmTokens);
        if (typeof npRes.timezone === 'string' && npRes.timezone) setTimezone(npRes.timezone);
        if (npRes.locale === 'en-US' || npRes.locale === 'en-GB') setLocale(npRes.locale);
        setIfChanged(setState, stRes);
        setStateSampleStartedAt(stateStartedAt);
        if (reconcile) setReconciliationId(sequence);

        // Session/AIR is below the fold and not part of first-paint identity.
        // Fetch it only after the critical feed has committed; failures remain
        // isolated so they cannot discard a successful now-playing update.
        if (!sessionInFlight) {
          sessionInFlight = true;
          void client.session().then(seRes => {
            if (!stopped && seRes && Array.isArray(seRes.messages)) {
              rawSessionRef.current = seRes;
              applySession();
            }
          }).catch(() => {}).finally(() => {
            sessionInFlight = false;
          });
        }
      } catch {
        // Keep the last known song through transient failures. HTTP errors are
        // not empty broadcast metadata, and a failed request must never erase it.
      } finally {
        if (sequence === requestSequence) inFlight = false;
      }
    };
    const stopPolling = pollWhileVisible(() => { void tick(); }, 5000);
    // A returning page must supersede a request begun before it was frozen. The
    // feed applies the newest coherent now-playing/state pair only; old requests
    // cannot repaint a stale identity after this foreground sample lands.
    const reconcile = () => {
      if (!document.hidden) void tick(true);
    };
    document.addEventListener('visibilitychange', reconcile);
    window.addEventListener('focus', reconcile);
    window.addEventListener('pageshow', reconcile);
    return () => {
      stopped = true;
      requestController?.abort();
      stopPolling();
      document.removeEventListener('visibilitychange', reconcile);
      window.removeEventListener('focus', reconcile);
      window.removeEventListener('pageshow', reconcile);
      // A held track switch (or a held spoken line) must not land after teardown.
      if (promoteTimerRef.current) {
        clearTimeout(promoteTimerRef.current);
        promoteTimerRef.current = null;
      }
      if (voiceTimerRef.current) {
        clearTimeout(voiceTimerRef.current);
        voiceTimerRef.current = null;
      }
    };
  }, [client, stationClock]);

  return { stationClock, nowPlaying, context, dj, activeShow, listeners, streamOnline, stream, llmTokens, state, session, trackStartedAt, trackPausedAt, opusEnabled, timezone, locale, stateSampleStartedAt, reconciliationId };
}
