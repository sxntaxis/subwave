import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionAttempt, SELECTION_CANDIDATE_IDS, SELECTION_CONTEXT_IDS } from '../src/llm/internal/tools/picker/selection-attempt.js';

test('transactions serialize eligibility through commit and recover after an error', async () => {
  const attempt = createSelectionAttempt();
  const seen = new Set<string>();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = attempt.transaction(async () => {
    assert.equal(seen.has('x'), false);
    await gate;
    seen.add('x');
  });
  const second = attempt.transaction(async () => seen.has('x'));
  release();
  await first;
  assert.equal(await second, true);
  await assert.rejects(attempt.transaction(async () => { throw new Error('fail'); }));
  assert.equal(await attempt.transaction(async () => 42), 42);
});

test('lookup bounds distinct candidates and context without invoking a rejected lookup', async () => {
  const attempt = createSelectionAttempt();
  let calls = 0;
  const read = async (ids: readonly string[]) => { calls++; return ids; };
  const ids = Array.from({ length: SELECTION_CANDIDATE_IDS }, (_, i) => `c${i}`);
  assert.equal((await attempt.lookup(ids, ['c0', 'predecessor'], read))?.length, ids.length + 1);
  assert.equal(await attempt.lookup(['new'], [], read), null);
  assert.equal(await attempt.lookup([], Array.from({ length: SELECTION_CONTEXT_IDS + 1 }, (_, i) => `x${i}`), read), null);
  assert.equal(calls, 1);
  const contexts = createSelectionAttempt();
  assert.ok(await contexts.lookup(['c'], ['a', 'b', 'd'], read));
  assert.equal(await contexts.lookup(['c'], ['e', 'f', 'g', 'h'], read), null);
});

test('lookup fails open on errors and shares one bounded asynchronous wait', async () => {
  const attempt = createSelectionAttempt();
  assert.equal(await attempt.lookup(['x'], [], async () => { throw new Error('unavailable'); }), null);
  const started = performance.now();
  assert.equal(await attempt.lookup(['x'], [], () => new Promise(() => {})), null);
  assert.ok(performance.now() - started < 1500);
  let called = false;
  assert.equal(await attempt.lookup(['x'], [], async () => { called = true; return 1; }), null);
  assert.equal(called, false);
});
