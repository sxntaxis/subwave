import assert from 'node:assert/strict';
import test from 'node:test';
import { choosePendingMusic, newReservation, verifiedHumanStart } from '../src/broadcast/queue/human-priority.js';
import type { QueueItem } from '../src/broadcast/queue/types.js';
const item = (id: string, extra: Partial<QueueItem> = {}): QueueItem => ({ track: { id, title: id }, ...extra });

test('arrival order, not asynchronous resolver completion order, owns listener priority', () => {
  const reservations = [newReservation('A', 1), { ...newReservation('B', 2), status: 'queued' as const }];
  const candidates = [item('ai'), item('B', { priorityLane: 'listener', humanRequestId: 'B' })];
  assert.equal(choosePendingMusic(candidates, reservations, false), null, 'B must await A');
  reservations[0].status = 'queued';
  candidates.push(item('A', { priorityLane: 'listener', humanRequestId: 'A' }));
  assert.equal(choosePendingMusic(candidates, reservations, false)?.track.id, 'A');
  candidates[2].sent = true;
  assert.equal(choosePendingMusic(candidates, reservations, false), null, 'B may not pass a handed-over A');
  reservations.shift();
  candidates.splice(2,1);
  assert.equal(choosePendingMusic(candidates, reservations, false)?.track.id, 'B');
});

test('owner play-next overrides listener reservation and speculative AI', () => {
  const reservations = [newReservation('A', 1)];
  const list = [item('ai', { aiPicked: true }), item('admin', { priorityLane: 'operator' })];
  assert.equal(choosePendingMusic(list, reservations, false)?.track.id, 'admin');
});

test('locked block remains uninterrupted before listener priority', () => {
  const reservation = [{ ...newReservation('A', 1), status: 'queued' as const }];
  const list = [item('listener', { priorityLane: 'listener', humanRequestId: 'A' }),
    item('album-2', { block: { id: 'block', label: 'Album', index: 2, size: 3, locked: true } })];
  assert.equal(choosePendingMusic(list, reservation, true)?.track.id, 'album-2');
  list[1].sent = true;
  assert.equal(choosePendingMusic(list, reservation, true), null, 'a queued/playing block must not be split');
  assert.equal(choosePendingMusic(list, reservation, false)?.track.id, 'listener', 'after final block member, release');
});

test('no human reservations preserves ordinary candidate order and idle state', () => {
  assert.equal(choosePendingMusic([], [], false), null);
  assert.equal(choosePendingMusic([item('A'), item('B')], [], false)?.track.id, 'A');
});

test('verified editorial steering requires the exact aired URI token, not a coincidental id', () => {
  const token = 'c'.repeat(32);
  const listener = item('song-id', { humanRequestId: 'request-A', queueToken: token });
  const owner = item('song-id', { operator: true, queueToken: 'd'.repeat(32) });
  assert.equal(verifiedHumanStart(listener, token), 'listener');
  assert.equal(verifiedHumanStart(listener, 'd'.repeat(32)), 'auto');
  assert.equal(verifiedHumanStart(listener, null), 'auto');
  assert.equal(verifiedHumanStart({ ...listener, queueToken: undefined }, token), 'auto', 'recovered attribution is not proof');
  assert.equal(verifiedHumanStart(owner, owner.queueToken), 'admin');
  assert.equal(verifiedHumanStart(owner, null), 'auto');
});
