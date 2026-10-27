import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIO_SIGNAL_HOLD_MS,
  AUDIO_SIGNAL_THRESHOLD_DBFS,
  EMPTY_AUDIO_SIGNAL_EVIDENCE,
  observeAudioSignal,
  rmsDbfs,
} from '../lib/audioSignalEvidence';

test('decoded PCM RMS is finite at silence and reflects full-scale amplitude', () => {
  assert.equal(rmsDbfs(new Float32Array(32)), -120);
  assert.ok(Math.abs((rmsDbfs(new Float32Array(32).fill(0.1)) ?? 0) - -20) < 0.01);
  assert.equal(rmsDbfs([]), null);
  assert.equal(rmsDbfs([0.1, Number.NaN]), null);
});

test('paused-mount silence stays below the detection threshold', () => {
  let evidence = EMPTY_AUDIO_SIGNAL_EVIDENCE;
  for (const at of [0, 100, 200, 300, 400]) {
    evidence = observeAudioSignal(evidence, -120, at);
  }
  assert.equal(evidence.detected, false);
  assert.equal(evidence.minRmsDbfs, -120);
  assert.equal(evidence.maxRmsDbfs, -120);
  assert.equal(AUDIO_SIGNAL_THRESHOLD_DBFS, -55);
});

test('one transient above threshold is insufficient; sustained current samples meet the hold', () => {
  let evidence = EMPTY_AUDIO_SIGNAL_EVIDENCE;
  evidence = observeAudioSignal(evidence, -30, 0);
  assert.equal(evidence.detected, false);
  evidence = observeAudioSignal(evidence, -120, 100);
  assert.equal(evidence.aboveSinceMs, null);
  evidence = observeAudioSignal(evidence, -30, 200);
  evidence = observeAudioSignal(evidence, -30, 300);
  assert.equal(evidence.detected, false);
  evidence = observeAudioSignal(evidence, -30, 400);
  assert.equal(evidence.detected, true);
  assert.equal(evidence.detectedAtMs, 400);
  assert.equal(AUDIO_SIGNAL_HOLD_MS, 200);
});

test('a delayed/hidden sampling gap restarts the sustained-signal window', () => {
  let evidence = EMPTY_AUDIO_SIGNAL_EVIDENCE;
  evidence = observeAudioSignal(evidence, -30, 0);
  evidence = observeAudioSignal(evidence, -30, 100);
  evidence = observeAudioSignal(evidence, -30, 300);
  assert.equal(evidence.detected, false);
  assert.equal(evidence.aboveSinceMs, 300);
  evidence = observeAudioSignal(evidence, -30, 400);
  evidence = observeAudioSignal(evidence, -30, 500);
  assert.equal(evidence.detected, true);
});

test('quiet opening below the conservative threshold is not forced into a signal result', () => {
  let evidence = EMPTY_AUDIO_SIGNAL_EVIDENCE;
  for (const at of [0, 100, 200, 300]) {
    evidence = observeAudioSignal(evidence, -60, at);
  }
  assert.equal(evidence.detected, false);
  assert.equal(evidence.maxRmsDbfs, -60);
});

test('once detected, later samples cannot extend or rewrite the evidence', () => {
  let evidence = EMPTY_AUDIO_SIGNAL_EVIDENCE;
  for (const at of [0, 100, 200]) evidence = observeAudioSignal(evidence, -30, at);
  const detected = evidence;
  evidence = observeAudioSignal(evidence, -120, 300);
  assert.equal(evidence, detected);
});
