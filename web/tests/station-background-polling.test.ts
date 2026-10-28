import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollStationFeed, type StationPollingEnvironment } from '../lib/stationPolling.ts';
import { stationFeedMetadata } from '../lib/stationFeedMetadata.ts';

// Scheduler/state unit harness only: no DOM, rendering, browser or media fixture.
function scheduler() {
  let hidden = false;
  let playing = true;
  let now = 0;
  let id = 0;
  const scheduled = new Map<number, { at: number; callback: () => void }>();
  const visibility = new EventTarget();
  const foreground = new EventTarget();
  const calls: { at: number; reconcile: boolean }[] = [];
  const environment: StationPollingEnvironment = {
    hidden: () => hidden,
    now: () => now,
    schedule(callback, delay) {
      const next = ++id;
      scheduled.set(next, { at: now + delay, callback });
      return next as unknown as ReturnType<typeof setTimeout>;
    },
    cancel(timer) { scheduled.delete(timer as unknown as number); },
    visibility, foreground,
  };
  const stop = pollStationFeed(reconcile => calls.push({ at: now, reconcile }), () => playing, environment);
  return {
    calls, stop, scheduled,
    hide() { hidden = true; visibility.dispatchEvent(new Event('visibilitychange')); },
    show() { hidden = false; visibility.dispatchEvent(new Event('visibilitychange')); },
    focus() { foreground.dispatchEvent(new Event('focus')); },
    pageshow() { foreground.dispatchEvent(new Event('pageshow')); },
    pause() { playing = false; },
    play() { playing = true; },
    freezeFor(ms: number) { now += ms; },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...scheduled].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        scheduled.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = end;
    },
  };
}

test('visible metadata uses the normal 5s cadence; hidden playing metadata uses 15s', () => {
  const s = scheduler();
  s.advance(5000);
  assert.deepEqual(s.calls, [{ at: 0, reconcile: false }, { at: 5000, reconcile: false }]);
  s.hide();
  s.advance(14999);
  assert.equal(s.calls.length, 2);
  s.advance(1);
  assert.deepEqual(s.calls.at(-1), { at: 20000, reconcile: true });
  s.stop();
});

test('hidden paused audio makes no requests and starts refreshing when playback resumes', () => {
  const s = scheduler();
  s.pause(); s.hide(); s.advance(45000);
  assert.equal(s.calls.length, 1);
  s.play(); s.advance(15000);
  assert.deepEqual(s.calls.at(-1), { at: 60000, reconcile: true });
  s.stop();
});

test('foreground revalidates immediately, coalescing visibility/focus/pageshow', () => {
  const s = scheduler();
  s.hide(); s.advance(15000); s.show(); s.focus(); s.pageshow();
  assert.equal(s.calls.length, 3);
  assert.deepEqual(s.calls.at(-1), { at: 15000, reconcile: true });
  s.advance(5000);
  assert.deepEqual(s.calls.at(-1), { at: 20000, reconcile: false });
  s.stop();
});

test('after suspended timers, foreground cancels the overdue cadence instead of replaying it', () => {
  const s = scheduler();
  s.hide(); s.freezeFor(120000); s.show();
  assert.deepEqual(s.calls, [{ at: 0, reconcile: false }, { at: 120000, reconcile: true }]);
  assert.equal(s.scheduled.size, 1);
  s.stop();
});

test('cleanup cancels polling and foreground listeners', () => {
  const s = scheduler();
  s.stop(); s.hide(); s.show(); s.focus(); s.advance(60000);
  assert.equal(s.calls.length, 1);
  assert.equal(s.scheduled.size, 0);
});

test('live marker miss preserves the accepted track; new metadata supersedes it', () => {
  const old = { title: 'Current', subsonic_id: 'one' };
  const next = { title: 'Next', subsonic_id: 'two' };
  assert.strictEqual(stationFeedMetadata(null, old, true, false), old);
  assert.strictEqual(stationFeedMetadata(next, old, true, false), next);
  assert.equal(stationFeedMetadata(null, null, true, false), null);
});

test('explicit off-air/idle and unknown availability do not reuse stale metadata', () => {
  const old = { title: 'Current' };
  assert.equal(stationFeedMetadata(null, old, false, false), null);
  assert.equal(stationFeedMetadata(null, old, true, true), null);
  assert.equal(stationFeedMetadata(null, old, undefined, false), null);
});
