import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceDirection, empty, type DirectionRecord } from '../src/broadcast/dj-agent/music-direction-core.js';

const t0 = Date.parse('2026-11-22T06:00:00.000Z');
const start = (n: number, source: 'auto' | 'listener' | 'admin' = 'auto', showId: string | null = 'freeform') => ({
  eventId: `start-${n}`, trackId: `song-${n}`, title: `Song ${n}`, artist: 'Artist', source, showId,
  at: t0 + n * 180_000,
});

test('only a verified actual start creates a listener anchor; four subsequent starts exhaust it', () => {
  let s = empty();
  assert.equal(s.steering, null);
  s = advanceDirection(s, start(0, 'listener'));
  assert.equal(s.steering?.source, 'listener');
  assert.equal(s.steering?.remainingStarts, 4);
  const same = advanceDirection(s, start(0, 'listener'));
  assert.equal(same, s, 'same physical start event must be idempotent');
  for (let i = 1; i <= 4; i++) {
    s = advanceDirection(s, start(i));
    assert.equal(s.steering?.remainingStarts ?? 0, 4 - i);
  }
  assert.equal(s.steering, null);
});

test('new listener song reroutes a prior listener anchor', () => {
  const first = advanceDirection(empty(), start(0, 'listener'));
  const rerouted = advanceDirection(first, start(1, 'listener'));
  assert.equal(rerouted.steering?.anchorTrackId, 'song-1');
  assert.equal(rerouted.steering?.remainingStarts, 4);
  assert.notEqual(rerouted.steering?.id, first.steering?.id);
});

test('admin directive remains above listener anchor and respects show bounds', () => {
  let s: DirectionRecord = { ...empty(), steering: {
    id: 'admin', source: 'admin', kind: 'hold', intent: 'Keep progressive jazz',
    scope: 'current-show', showId: 'freeform', anchorTrackId: null,
    anchorAt: new Date(t0).toISOString(), createdAt: new Date(t0).toISOString(),
    expiresAt: new Date(t0 + 45 * 60_000).toISOString(), remainingStarts: 8, followedStarts: 0,
  } };
  s = advanceDirection(s, start(1, 'listener'));
  assert.equal(s.steering?.id, 'admin', 'listener must not supersede explicit admin authority');
  s = advanceDirection(s, start(2, 'auto', 'afterhours'));
  assert.equal(s.steering, null, 'current-show directive must not leak across show roll');
});

test('a speculative model movement commits only when that exact selection starts', () => {
  const p = { movement: 'Soft opening', destination: 'Complex electronics', next: 'open the rhythm', horizonMinutes: 30,
    energy: 'build' as const };
  let s: DirectionRecord = { ...empty(), pending: { trackId: 'song-1', revision: 0, showId: 'freeform', proposal: p } };
  s = advanceDirection(s, start(0));
  assert.equal(s.movement, null);
  assert.equal(s.pending, null);
  s = { ...empty(), pending: { trackId: 'song-1', revision: 0, showId: 'freeform', proposal: p } };
  s = advanceDirection(s, start(1));
  assert.equal(s.movement?.destination, 'Complex electronics');
  assert.equal(s.movement?.energy, 'build');
  assert.equal(s.pending, null);
  const stale: DirectionRecord = { ...empty(), revision: 4, pending: { trackId: 'song-1', revision: 3, showId: 'freeform', proposal: p } };
  assert.equal(advanceDirection(stale, start(1)).movement, null, 'human epoch invalidates a soft plan');
});

test('movement expires, human arrival clears soft movement, and scopes remain distinct', () => {
  const state: DirectionRecord = { ...empty(), movement: {
    id: 'movement', movement: 'drift', destination: 'glitch', next: 'build', energy: 'build',
    originRevision: 0, showId: 'freeform', startedAt: new Date(t0).toISOString(),
    expiresAt: new Date(t0 + 15 * 60_000).toISOString(),
  } };
  const before = advanceDirection(state, start(1));
  assert.equal(before.movement?.id, 'movement');
  const after = advanceDirection(before, { ...start(2), eventId: 'new-show', showId: 'afterhours' });
  assert.equal(after.movement, null);
  const listener = advanceDirection(state, start(3, 'listener'));
  assert.equal(listener.movement, null);
});
