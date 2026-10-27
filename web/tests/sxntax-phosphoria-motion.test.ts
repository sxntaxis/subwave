import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  advanceAudioEnvelope,
  EMPTY_AUDIO_ENVELOPE,
  fluidParameters,
  fluidParametersChanged,
  PHOSPHORIA_FLUID_CONTROLS,
  spectralEnergy,
} from '../components/skins/sxntax/phosphoriaMotion';

test('missing analyser never fabricates a music-reactive pulse', () => {
  assert.equal(spectralEnergy(null, 44100), null);
  assert.equal(spectralEnergy(new Uint8Array(0), 44100), null);
  assert.equal(advanceAudioEnvelope(EMPTY_AUDIO_ENVELOPE, null, 0.1).pulse, 0);
});

test('frequency bands distinguish bass and high percussion', () => {
  const bass = new Uint8Array(2048), high = new Uint8Array(2048);
  bass.fill(200, 6, 35); high.fill(200, 400, 700);
  const b = spectralEnergy(bass, 44100)!, h = spectralEnergy(high, 44100)!;
  assert.ok(b.bass > b.highs);
  assert.ok(h.highs > h.bass);
  assert.equal(spectralEnergy(new Uint8Array(2048), 44100)?.overall, 0);
});

test('relative onset attacks and gradually decays against a moving baseline', () => {
  let state = advanceAudioEnvelope(EMPTY_AUDIO_ENVELOPE, 0.1, 0.05);
  state = advanceAudioEnvelope(state, 0.75, 0.08);
  assert.ok(state.pulse > 0.3);
  const peak = state.pulse;
  for (let i=0;i<30;i++) state=advanceAudioEnvelope(state, 0.1, 0.05);
  assert.ok(state.pulse < peak / 2);
});

test('missing signal restores authentic baseline Kawarp settings', () => {
  const speed = 1.16;
  const p = fluidParameters(speed, null, EMPTY_AUDIO_ENVELOPE, 0);
  assert.deepEqual(p, { warpIntensity: 1, animationSpeed: speed, saturation: 1.5, scale: 1 });
});

test('bass, percussive onset and mids animate the Kawarp field without orbital planes', () => {
  const quiet = { bass: 0.05, mids: 0.06, highs: 0.01, overall: 0.05 };
  const loud = { bass: 0.8, mids: 0.62, highs: 0.7, overall: 0.75 };
  const resting = { baseline: .12, level: .12, pulse: 0, initialized: true };
  const beat = { baseline: .12, level: .8, pulse: .9, initialized: true };
  const q = fluidParameters(1, quiet, resting, 0);
  const b = fluidParameters(1, loud, beat, 0);
  assert.ok(b.warpIntensity > q.warpIntensity);
  assert.ok(b.animationSpeed > q.animationSpeed);
  assert.ok(b.saturation > q.saturation);
  assert.ok(b.scale > q.scale);
  assert.ok(b.warpIntensity <= 1);
});

test('station handoff affects Kawarp parameters, while existing image crossfade remains separate', () => {
  const signal = { bass: .4, mids: .25, highs: .18, overall: .32 };
  const envelope = { baseline: .3, level: .4, pulse: .2, initialized: true };
  const steady = fluidParameters(1, signal, envelope, 0);
  const crossing = fluidParameters(1, signal, envelope, 1);
  assert.ok(crossing.warpIntensity > steady.warpIntensity);
  assert.ok(crossing.animationSpeed > steady.animationSpeed);
});

test('independent strengths disable only their corresponding controls', () => {
  const signal = { bass: .7, mids: .6, highs: .5, overall: .63 };
  const envelope = { baseline: .2, level: .7, pulse: .8, initialized: true };
  const c = PHOSPHORIA_FLUID_CONTROLS;
  const base = fluidParameters(1.12, signal, envelope, 0, { ...c, warpStrength: 0, flowStrength: 0, colorStrength: 0, scaleStrength: 0 });
  assert.equal(base.warpIntensity, 0.77);
  assert.equal(base.animationSpeed, 1.12);
  assert.equal(base.saturation, 1.5);
  assert.equal(base.scale, 1);
});

test('invalid audio measurements and clock values are bounded', () => {
  const prev = advanceAudioEnvelope(EMPTY_AUDIO_ENVELOPE, 5, -3);
  assert.equal(prev.baseline, 1);
  const next = advanceAudioEnvelope(prev, Number.NaN, 1);
  assert.equal(next.initialized, false);
  assert.ok(Number.isFinite(next.level));
  const p = fluidParameters(Number.POSITIVE_INFINITY, { bass: 2, mids: -3, highs: 4, overall: 5 }, { baseline: 1, level: 3, pulse: 5, initialized: true }, 3);
  assert.ok(p.warpIntensity <= 1 && p.scale <= 4);
});

test('the React wrapper avoids redundant control commits without limiting Kawarp FPS', () => {
  const original = fluidParameters(1, null, EMPTY_AUDIO_ENVELOPE, 0);
  assert.equal(fluidParametersChanged(original, { ...original, warpIntensity: original.warpIntensity - 0.001 }), false);
  assert.equal(fluidParametersChanged(original, { ...original, warpIntensity: original.warpIntensity - 0.03 }), true);
  assert.equal(PHOSPHORIA_FLUID_CONTROLS.controlUpdateHz, 30);
});

test('handoff still affects flow when audio analysis is unavailable', () => {
  const steady = fluidParameters(1, null, EMPTY_AUDIO_ENVELOPE, 0);
  const crossing = fluidParameters(1, null, EMPTY_AUDIO_ENVELOPE, 1);
  assert.equal(steady.warpIntensity, 1);
  assert.ok(crossing.animationSpeed > steady.animationSpeed);
  assert.ok(crossing.scale > steady.scale);
});
