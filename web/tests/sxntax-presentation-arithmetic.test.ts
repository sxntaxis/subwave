import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentationHeight } from '../components/skins/sxntax/lyrics/presentationGeometry.ts';

test('one reversible progress value supplies both extent endpoints', () => {
  assert.equal(presentationHeight(260, 610, 0), 260);
  assert.equal(presentationHeight(260, 610, 1), 610);
  assert.equal(presentationHeight(260, 610, .5), 435);
  assert.equal(presentationHeight(260, 610, -.2), 260);
  assert.equal(presentationHeight(260, 610, 1.2), 610);
});

test('height interpolation handles contraction using the same progress', () => {
  assert.equal(presentationHeight(650, 400, .5), 525);
  assert.equal(presentationHeight(650, 400, 1), 400);
});
