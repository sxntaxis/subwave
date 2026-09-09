import assert from 'node:assert/strict';
import test from 'node:test';

import { pickTargetValid } from '../src/broadcast/queue/pick-target.js';
import { queue as queueSingleton } from '../src/broadcast/queue.js';
import { poolAnchor } from '../src/music/picker-anchor.js';

const item = (title: string) => ({ track: { id: title, title } });

function testQueue() {
  const queue = queueSingleton;
  queue.current = null;
  queue.upcoming = [];
  const logs: Array<{ kind: string; message: string }> = [];
  queue.persist = () => {};
  queue.drainToLiquidsoap = async () => {};
  queue.log = (kind, message) => { logs.push({ kind, message }); };
  return { queue, logs };
}

test('ordinary current target remains valid only while its successor slot is open', () => {
  const a = item('A');
  const c = item('C');
  const target = { kind: 'current' as const, item: a };

  assert.equal(pickTargetValid(target, a, []), true);
  assert.equal(pickTargetValid(target, a, [c]), false);
  assert.equal(pickTargetValid(target, c, []), false);
});

test('request/manual interposition invalidates an ordinary target', () => {
  const a = item('A');
  const c = item('C');
  assert.equal(pickTargetValid({ kind: 'current', item: a }, a, [c]), false);
});

test('pair-drain target remains valid while it is the exact queue tail', () => {
  const x = item('X');
  const y = item('Y');
  const c = item('C');
  const target = { kind: 'held-tail' as const, item: y };

  assert.equal(pickTargetValid(target, x, [y]), true);
  assert.equal(pickTargetValid(target, x, [y, c]), false);
  assert.equal(pickTargetValid(target, x, []), false);
  assert.equal(pickTargetValid(target, y, [c]), false);
});

test('valid ordinary and pair targets permit the intended append', () => {
  const a = item('A');
  const y = item('Y');
  assert.equal(pickTargetValid({ kind: 'current', item: a }, a, []), true);
  assert.equal(pickTargetValid({ kind: 'held-tail', item: y }, a, [y]), true);
});

test('pair-drain pool anchor prefers explicit Y over live X', () => {
  const x = { title: 'X' };
  const y = { title: 'Y' };
  assert.equal(poolAnchor(y, x), y);
  assert.equal(poolAnchor(undefined, x), x);
});

test('AI commit drops an ordinary stale result and preserves the interposed request', async () => {
  const { queue, logs } = testQueue();
  const a = item('A');
  const b = item('B');
  const c = item('C');
  queue.current = a;
  await queue.push({ track: c.track, requestedBy: 'listener' });

  const outcome = await queue.pushAiPick({ track: b.track, aiPicked: true }, { kind: 'current', item: a });
  assert.equal(outcome, 'stale');
  assert.deepEqual(queue.upcoming.map(i => i.track.title), ['C']);
  assert.equal(logs.filter(l => l.kind === 'ai-pick').length, 0);
  assert.equal(logs.filter(l => l.kind === 'stale-pick').length, 1);
});

test('AI commit accepts an ordinary valid result', async () => {
  const { queue } = testQueue();
  const a = item('A');
  const b = item('B');
  queue.current = a;

  const outcome = await queue.pushAiPick({ track: b.track, aiPicked: true }, { kind: 'current', item: a });
  assert.notEqual(outcome, 'stale');
  assert.deepEqual(queue.upcoming.map(i => i.track.title), ['B']);
});

test('AI commit accepts a valid pair-drain successor and rejects interposition', async () => {
  const { queue } = testQueue();
  const x = item('X');
  const y = item('Y');
  const z = item('Z');
  queue.current = x;
  queue.upcoming = [y];
  assert.notEqual(
    await queue.pushAiPick({ track: z.track, aiPicked: true }, { kind: 'held-tail', item: y }),
    'stale',
  );
  assert.deepEqual(queue.upcoming.map(i => i.track.title), ['Y', 'Z']);

  const c = item('C');
  queue.upcoming.push(c);
  const stale = await queue.pushAiPick({ track: item('LATE').track, aiPicked: true }, { kind: 'held-tail', item: y });
  assert.equal(stale, 'stale');
  assert.deepEqual(queue.upcoming.map(i => i.track.title), ['Y', 'Z', 'C']);
});

test('a held predecessor that already started is stale', async () => {
  const { queue } = testQueue();
  const x = item('X');
  const y = item('Y');
  queue.current = y;
  const stale = await queue.pushAiPick({ track: item('Z').track, aiPicked: true }, { kind: 'held-tail', item: y });
  assert.equal(stale, 'stale');
  assert.deepEqual(queue.upcoming, []);
});
