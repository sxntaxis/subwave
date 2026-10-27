import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeLyricsPositionMs } from '../components/skins/sxntax/lyrics/lyricsPosition';

test('live duration is respected when the source start time is stale', () => {
  assert.equal(safeLyricsPositionMs(317 * 60 + 16, 410), null);
  assert.equal(safeLyricsPositionMs(250, 410), 250000);
  assert.equal(safeLyricsPositionMs(420, 410), 420000);
  assert.equal(safeLyricsPositionMs(441, 410), null);
});

test('unknown duration allows otherwise valid elapsed estimates', () => {
  assert.equal(safeLyricsPositionMs(12.5, null), 12500);
  assert.equal(safeLyricsPositionMs(-1, null), null);
  assert.equal(safeLyricsPositionMs(Number.POSITIVE_INFINITY, null), null);
});
