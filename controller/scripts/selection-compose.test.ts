import assert from 'node:assert/strict';
import test from 'node:test';
import { composeSelection, type RankedCandidate } from '../src/music/selection-compose.js';

const row = (id: string, artistKey: string, utility: number, baselineIndex: number, vector?: number[]): RankedCandidate<string> =>
  ({ value: id, id, artistKey, utility, baselineIndex, acoustic: vector ? { vector } : null });

test('MMR selects distinct sounding options without exceeding artist cap', () => {
  const rows = [row('a', 'x', 1, 0, [1, 0]), row('b', 'x', 0.99, 1, [1, 0]),
    row('c', 'y', 0.96, 2, [-1, 0]), row('d', 'z', 0.8, 3)];
  assert.deepEqual(composeSelection(rows, 3, 1), ['a', 'c', 'd']);
});

test('missing vectors preserve baseline ordering on ties and dedupe IDs', () => {
  const rows = [row('b', 'x', 0.5, 1), row('a', 'x', 0.5, 0), row('a', 'x', 0.5, 2)];
  assert.deepEqual(composeSelection(rows, 8, Infinity), ['a', 'b']);
  assert.deepEqual(composeSelection(rows, 0, Infinity), []);
});
