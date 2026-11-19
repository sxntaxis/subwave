import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectionContext } from '../src/broadcast/dj-agent/selection-context.js';

const item = (id: string, extra = {}) => ({ track: { id }, startedAt: new Date().toISOString(), ...extra }) as any;
const resolve = () => 'show';
const at = new Date();

test('uses current or held tail as the exact predecessor; novelty contains aired tracks only', () => {
  const current = item('current'), held = item('held'), earlier = item('earlier');
  assert.deepEqual(selectionContext({ kind: 'current', item: current }, current, [], [earlier], at, 'show', resolve),
    { predecessorId: 'current', recentAiredIds: ['current', 'earlier'] });
  assert.deepEqual(selectionContext({ kind: 'held-tail', item: held }, current, [held], [earlier], at, 'show', resolve),
    { predecessorId: 'held', recentAiredIds: ['current', 'earlier'] });
  assert.equal(selectionContext({ kind: 'current', item: current }, current, [held], [], at, 'show', resolve), undefined);
  assert.equal(selectionContext({ kind: 'held-tail', item: held }, current, [held, item('later')], [], at, 'show', resolve), undefined);
});

test('request, unknown show, bad timestamps and boundary uncertainty fall back', () => {
  const current = item('current');
  assert.equal(selectionContext({ kind: 'current', item: current }, current, [], [], at, null, resolve), undefined);
  assert.equal(selectionContext({ kind: 'current', item: current }, current, [], [], at, 'show', () => 'other'), undefined);
  const requested = item('requested', { requestedBy: 'listener' });
  assert.equal(selectionContext({ kind: 'current', item: requested }, requested, [], [], at, 'show', resolve), undefined);
  const invalid = item('invalid', { startedAt: 'not-a-date' });
  assert.equal(selectionContext({ kind: 'current', item: invalid }, invalid, [], [], at, 'show', resolve), undefined);
});
