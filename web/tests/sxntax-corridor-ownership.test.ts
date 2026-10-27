import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownedPresentationHeight } from '../components/skins/sxntax/lyrics/presentationGeometry.ts';

test('returning from Lyrics then settling a song always restores a concrete extent', () => {
  assert.equal(ownedPresentationHeight(260, 560, 1, true, 380), 560);
  assert.equal(ownedPresentationHeight(260, 560, 0, true, 380), 380);
  assert.equal(ownedPresentationHeight(380, 560, 0, false, null), 380);
});

test('shrinking and growing song handoffs reserve their supplied extent', () => {
  assert.equal(ownedPresentationHeight(210, 600, 0, true, 390), 390);
  assert.equal(ownedPresentationHeight(390, 600, 0, true, 210), 210);
  assert.equal(ownedPresentationHeight(210, 600, 0, false, null), 210);
});

test('reservation does not resize the reading aperture while Lyrics is active', () => {
  assert.equal(ownedPresentationHeight(300, 540, 1, true, 700), 540);
  assert.equal(ownedPresentationHeight(300, 540, .5, true, 700), 420);
});

test('a handoff awaiting geometry keeps current height; a release always reapplies normal', () => {
  assert.equal(ownedPresentationHeight(300, 540, 0, true, null), null);
  assert.equal(ownedPresentationHeight(300, 540, 0, false, null), 300);
});
