import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelectionHydrator } from '../src/music/selection-hydration.js';

test('attempt cache bounds candidate and context reads independently', () => {
  let calls = 0;
  const loader = createSelectionHydrator({
    metadata: () => { calls++; return { bpm: 100 }; },
    vector: () => { calls++; return [1, 0]; },
  }, () => 1);
  for (let i = 0; i < 260; i++) loader.get(`candidate-${i}`, 'candidate');
  for (let i = 0; i < 10; i++) loader.get(`context-${i}`, 'context');
  loader.get('candidate-0', 'candidate');
  assert.equal(loader.metrics.candidateIds, 256);
  assert.equal(loader.metrics.contextIds, 6);
  assert.equal(loader.metrics.vectorReads, 262);
  assert.equal(calls, 524);
  assert.equal(loader.metrics.budgetMisses, 8);
});

test('failed reads degrade to absent evidence and are cached', () => {
  const loader = createSelectionHydrator({ metadata: () => { throw Error('unavailable'); }, vector: () => null });
  assert.equal(loader.get('missing', 'candidate'), null);
  assert.equal(loader.get('missing', 'candidate'), null);
  assert.equal(loader.metrics.metadataReads, 1);
  assert.equal(loader.metrics.vectorReads, 1);
});
