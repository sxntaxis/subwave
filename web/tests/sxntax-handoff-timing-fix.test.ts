import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReconciliationGate } from '../components/skins/sxntax/trackPresentationState.ts';

test('foreground fast-settle is consumed once; later song polls keep their handoff', () => {
  const gate = createReconciliationGate();
  assert.equal(gate.consume(0), false);
  assert.equal(gate.consume(3), true);
  assert.equal(gate.consume(3), false); // same song enrichment
  assert.equal(gate.consume(3), false); // next song, same foreground generation
  assert.equal(gate.consume(7), true); // real foreground return
  assert.equal(gate.consume(7), false);
  assert.equal(gate.consume(NaN), false);
});
