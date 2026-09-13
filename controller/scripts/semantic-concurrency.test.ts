import assert from 'node:assert/strict';
import test from 'node:test';
import { runBoundedWorkers } from '../src/music/tag-library/semantic.js';

test('bounded semantic workers preserve membership and accounting under concurrency', async () => {
  for (const concurrency of [1, 4]) {
    const ids = Array.from({ length: 40 }, (_, index) => `fixture-${index}`);
    const seen: string[] = [];
    let active = 0;
    let peak = 0;
    await runBoundedWorkers(ids, concurrency, async (id) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      seen.push(id);
      active -= 1;
    });
    assert.equal(new Set(seen).size, 40);
    assert.deepEqual(new Set(seen), new Set(ids));
    assert.ok(peak <= concurrency);
    assert.ok(concurrency === 1 ? peak === 1 : peak > 1);
  }
});

test('bounded semantic workers stop dispatching after abort', async () => {
  const controller = new AbortController();
  const seen: string[] = [];
  await runBoundedWorkers(Array.from({ length: 20 }, (_, i) => i), 4, async (id) => {
    seen.push(String(id));
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 2));
  }, controller.signal);
  assert.ok(seen.length <= 4);
});

test('bounded semantic workers stop taking new tracks at the provider cap', async () => {
  const seen: number[] = [];
  let completedCalls = 0;
  await runBoundedWorkers(Array.from({ length: 20 }, (_, i) => i), 4, async (id) => {
    seen.push(id);
    await new Promise(resolve => setTimeout(resolve, 1));
    completedCalls += 1;
  }, undefined, () => seen.length >= 4);
  assert.equal(completedCalls, 4);
  assert.equal(seen.length, 4);
});
