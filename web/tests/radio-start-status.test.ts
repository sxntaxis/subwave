import assert from 'node:assert/strict';
import { test } from 'node:test';
import { radioPlaybackConfirmed, radioStartStatus } from '../components/skins/sxntax/radioStartStatus';
import { isCurrentPlayGeneration, mediaClockAdvancedForAttempt, mediaEventBelongsToAttempt } from '../lib/mediaAttemptEvidence';
import { playErrorClass, radioDiagnostic } from '../lib/radioDiagnostics';

const base = {
  tunedIn: true,
  playerStatus: 'connecting' as const,
  idleStopped: false,
  streamIdle: false,
  stateSampleStartedAt: 0,
  attemptStartedAt: 100,
  attemptStartedIdle: false,
  clockAdvanced: false,
  mediaWaiting: false,
  playFailure: null,
  connectingForMs: 0,
};

test('reports local untuned states without claiming that the station is asleep', () => {
  assert.equal(radioStartStatus({ ...base, tunedIn: false, idleStopped: true })?.text, 'LISTENING TIMED OUT — TUNE IN');
  assert.equal(radioStartStatus({ ...base, tunedIn: false, streamIdle: true })?.text, 'RADIO IDLE — TUNE IN TO LISTEN');
});

test('shows immediate connecting feedback, then only accepts a post-attempt idle-clear sample', () => {
  assert.equal(radioStartStatus(base)?.text, 'CONNECTING TO RADIO');
  assert.equal(radioStartStatus({ ...base, streamIdle: true })?.text, '[ WAIT ] BROADCAST REPORTED IDLE · WAITING FOR RESUME');
  assert.equal(radioStartStatus({ ...base, stateSampleStartedAt: 99 })?.text, 'CONNECTING TO RADIO');
  assert.equal(radioStartStatus({ ...base, stateSampleStartedAt: 100 })?.text, '[ OK ] IDLE GATE CLEAR');
});

test('prolonged connecting is presentation-only and buffering takes precedence', () => {
  assert.equal(radioStartStatus({ ...base, connectingForMs: 14_999 })?.text, 'CONNECTING TO RADIO');
  assert.equal(radioStartStatus({ ...base, connectingForMs: 15_000 })?.text, 'STILL CONNECTING — TUNE OUT, THEN TUNE IN TO RETRY');
  assert.equal(radioStartStatus({ ...base, streamIdle: true, mediaWaiting: true })?.text, '[ WAIT ] BUFFERING AUDIO');
});

test('requires browser clock advancement for ON AIR and surfaces autoplay/error states', () => {
  assert.equal(radioStartStatus({ ...base, playerStatus: 'playing' })?.text, 'CONNECTING TO RADIO');
  assert.equal(radioStartStatus({ ...base, playerStatus: 'playing', clockAdvanced: true }), null);
  assert.equal(radioStartStatus({ ...base, playFailure: 'NotAllowedError' })?.text, 'AUDIO NEEDS USER ACTION — TUNE OUT, THEN TUNE IN');
  assert.equal(radioStartStatus({ ...base, playFailure: 'NotSupportedError' })?.text, 'CONNECTION INTERRUPTED — TUNE OUT, THEN TUNE IN TO RETRY');
  assert.equal(radioStartStatus({ ...base, playerStatus: 'error' })?.text, 'CONNECTION INTERRUPTED');
});

test('diagnostics retain only the browser error class', () => {
  assert.equal(playErrorClass(Object.assign(new Error('private URL and token'), { name: 'NotAllowedError' })), 'NotAllowedError');
  assert.equal(playErrorClass(new Error('private URL and token')), 'OtherError');
  assert.equal(playErrorClass(null), 'UnknownError');
});

test('old source events cannot advance the new attempt clock or assert buffering', () => {
  assert.equal(mediaEventBelongsToAttempt('https://stream/current?t=2', 'https://stream/old?t=1'), false);
  assert.equal(mediaClockAdvancedForAttempt({
    expectedSource: 'https://stream/current?t=2', eventSource: 'https://stream/old?t=1', currentTime: 18, baseline: 0,
  }), false);
  assert.equal(mediaClockAdvancedForAttempt({
    expectedSource: 'https://stream/current?t=2', eventSource: 'https://stream/current?t=2', currentTime: 0, baseline: 0,
  }), false);
  assert.equal(mediaClockAdvancedForAttempt({
    expectedSource: 'https://stream/current?t=2', eventSource: 'https://stream/current?t=2', currentTime: 0.04, baseline: 0,
  }), true);
  const staleWaitingStillReportsOnlyGateEvidence = radioStartStatus({
    ...base,
    mediaWaiting: false,
    stateSampleStartedAt: 100,
  });
  assert.equal(staleWaitingStillReportsOnlyGateEvidence?.text, '[ OK ] IDLE GATE CLEAR');
  assert.equal(isCurrentPlayGeneration(4, 5), false);
  assert.equal(isCurrentPlayGeneration(5, 5), true);
});

test('late play settlement from a stopped generation cannot update the current attempt', async () => {
  let generation = 7;
  let visibleStatus = 'connecting';
  const staleResolve = Promise.resolve().then(() => {
    if (isCurrentPlayGeneration(6, generation)) visibleStatus = 'playing';
  });
  const staleReject = Promise.reject(new Error('private message')).catch(() => {
    if (isCurrentPlayGeneration(6, generation)) visibleStatus = 'error';
  });
  generation = 7; // Tune Out invalidated generation 6; generation 7 is current.
  await Promise.all([staleResolve, staleReject]);
  assert.equal(visibleStatus, 'connecting');
});

test('idle-gate-clear is not media readiness; buffering takes precedence over a prior clock advance', () => {
  const gateClear = radioStartStatus({ ...base, stateSampleStartedAt: 100 });
  assert.equal(gateClear?.text, '[ OK ] IDLE GATE CLEAR');
  assert.equal(gateClear?.tone, 'ok');
  assert.equal(radioStartStatus({ ...base, clockAdvanced: true, playerStatus: 'playing', mediaWaiting: true })?.text, '[ WAIT ] BUFFERING AUDIO');
  assert.equal(radioStartStatus({ ...base, clockAdvanced: true, playerStatus: 'playing' }), null);
});

test('idle Tune In with a moving silent-stream clock waits until a fresh gate-clear sample', () => {
  const waitingForProgramme = {
    ...base,
    attemptStartedIdle: true,
    streamIdle: true,
    clockAdvanced: true,
    playerStatus: 'playing' as const,
  };
  assert.equal(radioPlaybackConfirmed(waitingForProgramme), false);
  assert.equal(radioStartStatus(waitingForProgramme)?.text, '[ WAIT ] STREAM CONNECTED · WAITING FOR PROGRAMME');

  const resumedWithoutFrames = {
    ...waitingForProgramme,
    streamIdle: false,
    clockAdvanced: false,
    stateSampleStartedAt: 100,
  };
  assert.equal(radioPlaybackConfirmed(resumedWithoutFrames), false);
  assert.equal(radioStartStatus(resumedWithoutFrames)?.text, 'BROADCAST RESUMED · CONNECTING AUDIO');

  const bothVerified = { ...resumedWithoutFrames, clockAdvanced: true, playerStatus: 'playing' as const };
  assert.equal(radioPlaybackConfirmed(bothVerified), true);
  assert.equal(radioStartStatus(bothVerified), null);
});

test('a new non-idle attempt is not blocked waiting for an idle response', () => {
  const freshAttempt = {
    ...base,
    attemptStartedIdle: false,
    attemptStartedAt: 500,
    stateSampleStartedAt: 100,
    clockAdvanced: true,
    playerStatus: 'playing' as const,
  };
  assert.equal(radioPlaybackConfirmed(freshAttempt), true);
  assert.equal(radioStartStatus(freshAttempt), null);
});

test('diagnostics are silent by default and only serialize the safe detail allowlist when enabled', () => {
  const priorWindow = globalThis.window;
  const priorInfo = console.info;
  const records: unknown[] = [];
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: () => '0' } } });
    console.info = ((...args: unknown[]) => { records.push(args); }) as typeof console.info;
    radioDiagnostic(3, 'waiting', { title: 'private track', url: 'https://private/?token=secret' });
    assert.equal(records.length, 0);

    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: () => '1' } } });
    radioDiagnostic(3, 'waiting', {
      status: 'connecting',
      mediaTime: 1.23456,
      title: 'private track',
      url: 'https://private/?token=secret',
      errorClass: 'https://private/?token=secret',
    });
    const output = JSON.stringify(records);
    assert.match(output, /"status":"connecting"/);
    assert.match(output, /"mediaTime":1.235/);
    assert.doesNotMatch(output, /private track|private\/?|secret/);
  } finally {
    console.info = priorInfo;
    if (priorWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
  }
});
