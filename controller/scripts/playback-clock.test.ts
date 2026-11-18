import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlaybackClock } from '../src/broadcast/playback-clock.js';

const START = Date.parse('2026-10-20T20:00:00Z');
const ISO = new Date(START).toISOString();
const HOUR = 3600_000;

test('overnight standby freezes progress and resumes from the paused position', () => {
  const clock = new PlaybackClock();
  clock.setIdle(true, ISO, START + 90_000);
  // Reassertions and fresh /state reads must not move the pause boundary.
  clock.setIdle(true, ISO, START + 15 * HOUR);
  const paused = clock.snapshot(ISO)!;
  assert.equal((paused.pausedAt! - paused.startedAt) / 1000, 90);
  assert.deepEqual(clock.snapshot(ISO), paused);

  const resumeAt = START + 15 * HOUR;
  clock.setIdle(false, ISO, resumeAt);
  const resumed = clock.snapshot(ISO)!;
  assert.equal(resumed.pausedAt, null);
  assert.equal((resumeAt - resumed.startedAt) / 1000, 90);
  assert.equal((resumeAt + 12_000 - resumed.startedAt) / 1000, 102);
});

test('multiple standby cycles accumulate only paused time', () => {
  const clock = new PlaybackClock();
  clock.setIdle(true, ISO, START + 30_000);
  clock.setIdle(false, ISO, START + HOUR);
  clock.setIdle(true, ISO, START + HOUR + 20_000);
  const paused = clock.snapshot(ISO)!;
  assert.equal((paused.pausedAt! - paused.startedAt) / 1000, 50);
  clock.setIdle(false, ISO, START + 2 * HOUR);
  assert.equal((START + 2 * HOUR - clock.snapshot(ISO)!.startedAt) / 1000, 50);
});

test('a new track does not inherit the previous track’s idle time', () => {
  const clock = new PlaybackClock();
  clock.setIdle(true, ISO, START + 30_000);
  clock.setIdle(false, ISO, START + HOUR);
  const nextStart = START + HOUR + 100_000;
  assert.deepEqual(clock.snapshot(new Date(nextStart).toISOString()), {
    startedAt: nextStart, pausedAt: null,
  });
  assert.equal(clock.snapshot(undefined), null);
  assert.equal(clock.snapshot('invalid'), null);
});

test('adopting an idle gate before the current track is known excludes pre-track pause time', () => {
  const clock = new PlaybackClock();
  clock.setIdle(true, undefined, START);
  const recovered = new Date(START + 10_000).toISOString();
  assert.deepEqual(clock.snapshot(recovered), { startedAt: START + 10_000, pausedAt: START + 10_000 });
  clock.setIdle(false, recovered, START + HOUR);
  assert.equal(clock.snapshot(recovered)!.startedAt, START + HOUR);
});
