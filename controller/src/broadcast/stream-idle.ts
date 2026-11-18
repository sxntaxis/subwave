// Stream idle monitor — pause the programme while the room is empty.
//
// With settings.stream.idleWhenEmpty on and zero listeners for
// idleAfterMinutes, flip radio.liq's idle gate (telnet idle_on): the mounts
// stay up serving silence but the music chain stops being pulled, frozen
// mid-track. Any client still connects while idle, and the first connection
// resumes (idle_off) exactly where it froze. Contrast POST /stream-stop
// (stream_off), which tears the mounts down — the operator's hard off-air.
//
// Fail-OPEN: an unknown count (sustained failure, not one timed-out poll —
// #1256) never holds the station silent. Telnet failures keep the current state
// and retry next tick. State is not persisted; a mixer restart comes back live
// and the monitor re-asserts idle_on, and on controller boot the gate's state
// is adopted from Liquidsoap (idle_status). Transitions live in the pure
// nextIdleState().

import * as settings from '../settings.js';
import { warmHeavy } from '../audio/ttsHeavyClient.js';
import { gatedListenerCount, noteIdleResumeForDiagnostics, refresh, setStreamIdle } from './listeners.js';
import { idleOn, idleOff, idleStatus } from './liquidsoap-control.js';
import { queue } from './queue.js';
import { nextIdleState, type IdleState } from './stream-idle-pure.js';
import { PlaybackClock } from './playback-clock.js';

// One tick every 5s. Live: read the 15s monitor's cached count. Idle: force a
// fresh poll, so a new listener waits ~5s (worst case ~8s, since the forced
// poll is single-flighted). Tightening that would re-race the two pollers
// (#1256).
const TICK_MS = 5000;

let state: IdleState = { idle: false, zeroSince: null };
let gateAdopted = false;
const playbackClock = new PlaybackClock();

export function playbackTiming() {
  return playbackClock.snapshot(queue.current?.startedAt);
}

let idleListenerDiagnosticReported = false;

function radioDiagnostic(stage: string, detail: Record<string, string | number | boolean | null> = {}) {
  if (process.env.SUBWAVE_RADIO_DIAGNOSTICS !== '1') return;
  console.info(JSON.stringify({
    type: 'radio-diagnostic',
    component: 'controller',
    stage,
    monotonicMs: Number(performance.now().toFixed(1)),
    approximateWallTime: new Date().toISOString(),
    ...detail,
  }));
}

// Read by GET /state so the player can tell "nobody's here" from "broken".
export function isIdle() {
  return state.idle;
}

async function tick() {
  // A failed boot probe is unknown, not proof the mixer is live. Retry adoption
  // so a controller-only deploy cannot strand a still-paused mixer on connect.
  if (!gateAdopted) {
    try {
      state = { idle: await idleStatus(), zeroSince: null };
      playbackClock.setIdle(state.idle, queue.current?.startedAt, Date.now());
      setStreamIdle(state.idle);
      gateAdopted = true;
    } catch { return; }
  }
  const st = settings.get()?.stream;
  const enabled = !!st?.idleWhenEmpty;
  const idleAfterMin = Number(st?.idleAfterMinutes) >= 1 ? Number(st?.idleAfterMinutes) : 10;
  // Idle forces a fresh poll (the 15s cadence would add 15s to the wake-up).
  // Always read through gatedListenerCount(), never refresh()'s raw return: one
  // timed-out poll out of ~120 per pause released it (#1256).
  if (state.idle && enabled) await refresh();
  const count = gatedListenerCount();
  const { state: next, action } = nextIdleState(state, {
    enabled,
    count,
    now: Date.now(),
    idleAfterMs: idleAfterMin * 60_000,
  });
  if (state.idle && count !== null && count > 0 && !idleListenerDiagnosticReported) {
    idleListenerDiagnosticReported = true;
    radioDiagnostic('idle-listener-detected', { listeners: count });
  }
  try {
    if (action === 'pause') {
      const idleResult = await idleOn();
      radioDiagnostic(idleResult === 'OK' ? 'idle-entry-confirmed' : 'idle-entry-response-unconfirmed');
      if (idleResult !== 'OK') { gateAdopted = false; return; }
      queue.log(
        'scheduler',
        `programme idle-paused — no listeners for ${idleAfterMin} min (mounts stay up, resumes on connect)`,
      );
    } else if (action === 'resume') {
      radioDiagnostic('idle-off-issued');
      const idleResult = await idleOff();
      radioDiagnostic(idleResult === 'OK' ? 'idle-off-confirmed' : 'idle-off-response-unconfirmed');
      if (idleResult !== 'OK') { gateAdopted = false; return; }
      if (idleResult === 'OK') noteIdleResumeForDiagnostics();
      idleListenerDiagnosticReported = false;
      // Warm the tts-heavy sidecar (#1579): a cold Chatterbox reload is
      // 30-60s, audible if it lands on the first link after the room fills.
      // Not awaited and never throws — the render path reloads on its own, so
      // this must not delay idleOff() or trip the catch into holding the pause.
      void warmHeavy();
      queue.log(
        'scheduler',
        count !== null && count > 0
          ? 'programme resumed — listener connected'
          : 'programme resumed — idle pause released',
      );
    } else if (action === 'reassert') {
      if (await idleOn() !== 'OK') gateAdopted = false;
    }
  } catch {
    gateAdopted = false;
    if (action === 'resume') radioDiagnostic('idle-off-failed');
    return; // telnet unreachable — keep the current state, retry next tick
  }
  state = next;
  playbackClock.setIdle(next.idle, queue.current?.startedAt, Date.now());
  setStreamIdle(next.idle);
}

export function startStreamIdleMonitor() {
  void (async () => {
    // Adopt the gate's actual state: a restart mid-pause must not leave
    // Liquidsoap silent while we believe the programme is live.
    try {
      state = { idle: await idleStatus(), zeroSince: null };
      playbackClock.setIdle(state.idle, queue.current?.startedAt, Date.now());
      setStreamIdle(state.idle);
      gateAdopted = true;
    } catch {
      /* Liquidsoap not up yet — start live; ticks reconcile from here */
    }
    setInterval(() => {
      tick().catch(() => {});
    }, TICK_MS);
  })();
}
