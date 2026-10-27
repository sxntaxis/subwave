import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAudibleLyricsClock } from '../components/skins/sxntax/lyrics/audibleLyricsClock.ts';

test('timestamp correction converges at normal 60Hz media sampling', () => {
  const clock = createAudibleLyricsClock();
  const sample = (station: number, ms: number) => ({
    stationPositionMs: station, mediaTimeSeconds: 5 + ms / 1000,
    monoMs: ms, mediaSource: 'stream', playing: true,
  });
  clock.observe(sample(10000, 0));
  let position = 10000;
  for (let ms = 16; ms <= 3200; ms += 16) {
    position = clock.observe(sample(12000 + ms, ms)).positionMs!;
  }
  assert.ok(Math.abs(position - 15200) < 1);
});
