import assert from 'node:assert/strict';
import test from 'node:test';
import { createStationClock } from '../lib/stationClock.ts';
import { playbackElapsedSeconds } from '../lib/playbackTime.ts';
import { splitAudibleTurns } from '../lib/sessionFeed.ts';

const EPOCH = Date.parse('2026-10-25T06:00:00Z');
const START = EPOCH - 80_000;

test('station clock does not require or follow a listener wall clock', () => {
  let mono = 1050;
  const clock = createStationClock(() => mono);
  assert.equal(clock.nowMs(), null);
  assert.equal(clock.sample(EPOCH, 1000, 1100), true);
  mono = 1100;
  assert.equal(clock.nowMs(), EPOCH + 50);
  const nativeNow = Date.now;
  try {
    Date.now = () => EPOCH + 40 * 60 * 1000;
    assert.equal(clock.nowMs(), EPOCH + 50);
    Date.now = () => EPOCH - 40 * 60 * 1000;
    assert.equal(clock.nowMs(), EPOCH + 50);
  } finally {
    Date.now = nativeNow;
  }
  assert.equal(playbackElapsedSeconds(START + 6000, null, clock.nowMs()!), 74);
  mono = 6100;
  assert.equal(clock.nowMs(), EPOCH + 5050);
});

test('response latency is estimated from monotonic request timing', () => {
  const clock = createStationClock(() => 1500);
  assert.equal(clock.sample(EPOCH, 1000, 1500), true);
  assert.equal(clock.nowMs(), EPOCH + 250);
  assert.equal(clock.delayMs(EPOCH + 2250), 2000);
  assert.equal(clock.delayMs(EPOCH - 500), 0);
});

test('reject missing, invalid and excessively delayed server stamps', () => {
  const clock = createStationClock(() => 300);
  for (const stamp of [null, undefined, NaN, Infinity, 0, -1, 1e20]) {
    assert.equal(clock.sample(stamp, 100, 200), false);
  }
  assert.equal(clock.sample(EPOCH, 100, 5000), false);
  assert.equal(clock.sample(EPOCH, 500, 100), false);
  assert.equal(clock.nowMs(), null);
});

test('normal clock samples smooth jitter rather than resetting lyrics', () => {
  let mono = 100;
  const clock = createStationClock(() => mono);
  clock.sample(EPOCH, 0, 100);
  mono = 5200;
  const before = clock.nowMs()!;
  // Estimate is 80ms later than the prediction: slew only a quarter of it.
  clock.sample(EPOCH + 5200 + 80, 5100, 5200);
  const after = clock.nowMs()!;
  assert.ok(after - before >= 0 && after - before <= 100);
  mono += 500;
  assert.equal(clock.nowMs(), after + 500);
});

test('large discontinuities resynchronize immediately after resume', () => {
  let mono = 100;
  const clock = createStationClock(() => mono);
  clock.sample(EPOCH, 0, 100);
  mono = 10_000;
  assert.equal(clock.sample(EPOCH + 50_000, 9900, 10_000), true);
  assert.equal(clock.nowMs(), EPOCH + 50_050);
});

test('station pausedAt freezes lyrics and progress on server epoch', () => {
  const clock = createStationClock(() => 20_000);
  clock.sample(EPOCH, 0, 100);
  const pausedAt = EPOCH + 4000;
  assert.equal(playbackElapsedSeconds(EPOCH - 90_000, pausedAt, clock.nowMs()!), 94);
});

test('spoken-audio events follow the same listener lead clock', () => {
  const clock = createStationClock(() => 100);
  clock.sample(EPOCH, 0, 100);
  const messages = [{ role: 'segment', text: 'spoken', meta: { airedAt: new Date(EPOCH).toISOString() } }] as Parameters<typeof splitAudibleTurns>[0];
  const first = splitAudibleTurns(messages, 6000, clock.nowMs()!);
  assert.equal(first.visible.length, 0);
  assert.equal(first.nextChangeMs, EPOCH + 6000);
  const later = splitAudibleTurns(messages, 6000, clock.nowMs(6100)!);
  assert.equal(later.visible.length, 1);
});

test('reset drops stale samples so station changes cannot leak epochs', () => {
  const clock = createStationClock(() => 900);
  clock.sample(EPOCH, 0, 100);
  clock.reset();
  assert.equal(clock.nowMs(), null);
  assert.equal(clock.delayMs(EPOCH + 1000), null);
});
