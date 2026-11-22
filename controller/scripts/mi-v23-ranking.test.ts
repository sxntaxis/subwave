import assert from 'node:assert/strict';
import test from 'node:test';
import { orderByArousalDirection } from '../src/music/direction-rank.js';
const item = (id: string, mean: number | null, coverage: string = 'complete') => ({
  id, musical_evidence: mean === null ? null : { arousal: { mean, coverage } },
});

test('soft movement ordering never changes identities, eligibility or count', () => {
  const inputs = [item('calm', 1), item('medium', 5), item('intense', 9), item('unknown', null)];
  const result = orderByArousalDirection(inputs, 'build');
  assert.equal(result.length, inputs.length);
  assert.deepEqual(new Set(result.map(x => x.id)), new Set(inputs.map(x => x.id)));
  assert.equal(result[0].id, 'calm', 'baseline ranking remains significant');
  assert.deepEqual(orderByArousalDirection(inputs, null), inputs);
});

test('direction is soft and coverage-aware, not an invented probability', () => {
  const ordered = [item('low', 1), item('high', 9), item('partial', 9, 'partial')];
  const build = orderByArousalDirection(ordered, 'build');
  const release = orderByArousalDirection(ordered, 'release');
  assert.deepEqual(build.map(x => x.id).sort(), ordered.map(x => x.id).sort());
  assert.equal(release[0].id, 'low');
  assert.deepEqual(orderByArousalDirection([item('low',1), item('partial',9,'partial')], 'build').map(x=>x.id), ['low','partial']);
});
