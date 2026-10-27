import assert from 'node:assert/strict';
import { test } from 'node:test';
import { playbackElapsedSeconds } from '../lib/playbackTime';

test('an overnight-old pause stays frozen, including on a cold page load', () => {
  const start = 1_000_000;
  const pause = start + 90_000;
  assert.equal(playbackElapsedSeconds(start, pause, start + 15 * 3600_000), 90);
  assert.equal(playbackElapsedSeconds(start, pause, start + 16 * 3600_000), 90);
});

test('listener buffer delays the pause boundary rather than freezing progress early', () => {
  const liveStart = 1_000_000;
  const livePause = liveStart + 90_000;
  const lead = 22_000;
  assert.equal(playbackElapsedSeconds(liveStart + lead, livePause + lead, livePause), 68);
  assert.equal(playbackElapsedSeconds(liveStart + lead, livePause + lead, livePause + lead), 90);
});

test('normal playback advances, with unknown and future starts clamped to zero', () => {
  assert.equal(playbackElapsedSeconds(1000, null, 13_999), 12);
  assert.equal(playbackElapsedSeconds(null, null, 13_999), 0);
  assert.equal(playbackElapsedSeconds(20_000, null, 13_999), 0);
});
