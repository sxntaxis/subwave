import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceDirection, empty, type DirectionRecord } from '../src/broadcast/dj-agent/music-direction-core.js';
import { rememberAirplay, musicalMemoryView, emptyMemory, showPhaseInfo } from '../src/broadcast/dj-agent/music-director-v2-core.js';

const t = Date.parse('2026-11-22T07:00:00Z');
const start = (n: number, token: string | null = null, extra: object = {}) => ({
  eventId: `start-${n}`, trackId: `song-${n}`, title: `Song ${n}`, artist: `Artist ${n % 3}`,
  source: 'auto' as const, showId: 'freeform', at: t + n * 180_000,
  queueToken: token, directorV2: true, energy: n % 2 ? 'high' : 'low', moods: ['warm'], genre: 'rock',
  ...extra,
});
const proposal = { movement: 'Textural expansion', destination: 'Psychedelic electronics',
  next: 'Introduce repetition', energy: 'build' as const, horizonMinutes: 30 };

test('v2.4 cannot activate a speculative movement by same track ID without exact mixer token', () => {
  const pending: DirectionRecord = { ...empty(), pending: { trackId: 'song-1', token: 'a'.repeat(32),
    showId: 'freeform', revision: 0, proposal } };
  const collided = advanceDirection(pending, start(1, 'b'.repeat(32)));
  assert.equal(collided.movement, null);
  assert.equal(collided.pending, null);
  assert.equal(collided.memory?.recent.length, 1);
  const right = advanceDirection(pending, start(1, 'a'.repeat(32)));
  assert.equal(right.movement?.movement, 'Textural expansion');
  assert.equal(right.movement?.progress?.starts, 1);
  assert.equal(right.movement?.progress?.elapsedMinutes, 0);
  assert.equal(advanceDirection(right, start(1, 'a'.repeat(32))), right, 'same mixer event never counts twice');
});

test('development updates only on verified next selection; real starts advance progress', () => {
  const pending: DirectionRecord = { ...empty(), pending: { trackId: 'song-1', token: 'a'.repeat(32),
    showId: 'freeform', revision: 0, proposal } };
  let s = advanceDirection(pending, start(1, 'a'.repeat(32)));
  s = { ...s, pending: { trackId: 'song-2', token: 'c'.repeat(32), revision: 0, showId: 'freeform',
    development: { decision: 'continue', next: 'Introduce richer bass', alternate: 'Detour through dub' } } };
  s = advanceDirection(s, start(2, 'c'.repeat(32)));
  assert.equal(s.movement?.progress?.starts, 2);
  assert.equal(s.movement?.next, 'Introduce richer bass');
  assert.equal(s.movement?.progress?.alternate, 'Detour through dub');
  assert.equal(s.movement?.progress?.elapsedMinutes, 3);
  s = { ...s, pending: { trackId: 'song-3', token: 'd'.repeat(32), revision: 0, showId: 'freeform',
    development: { decision: 'resolve', next: 'Let the motif settle', alternate: 'Continue texture' } } };
  s = advanceDirection(s, start(3, 'd'.repeat(32)));
  assert.equal(s.movement, null);
  assert.equal(s.memory?.resolved[0].outcome, 'resolved');
  assert.equal(s.memory?.resolved[0].starts, 3);
  assert.equal(s.memory?.resolved[0].followOn, 'Let the motif settle');
});

test('admin steering cannot be displaced by an autonomous proposal', () => {
  const pending: DirectionRecord = { ...empty(), steering: {
    id: 'admin', source: 'admin', kind: 'pivot', intent: 'Move toward brighter music', showId: 'freeform',
    scope: 'station', anchorTrackId: null, anchorAt: new Date(t).toISOString(),
    createdAt: new Date(t).toISOString(), expiresAt: null, remainingStarts: null, followedStarts: 0,
  }, pending: { trackId: 'song-1', token: 'a'.repeat(32), showId: 'freeform', revision: 0, proposal } };
  const s = advanceDirection(pending, start(1, 'a'.repeat(32)));
  assert.equal(s.movement, null);
  assert.equal(s.steering?.source, 'admin');
});

test('show handoff closes old direction; memory has honest cross-show context', () => {
  let s = advanceDirection({ ...empty(), pending: { trackId: 'song-1', token: 'a'.repeat(32),
    showId: 'freeform', revision: 0, proposal } }, start(1, 'a'.repeat(32)));
  s = advanceDirection(s, start(2, null, { showId: 'signals' }));
  assert.equal(s.movement, null);
  assert.equal(s.memory?.resolved[0].outcome, 'show-change');
  const view = musicalMemoryView(s.memory!, 'signals');
  assert.equal(view.showStarts, 1);
  assert.equal(view.precedingShow?.showId, 'freeform');
});

test('memory is bounded, factual and distinct from a candidate queue', () => {
  let m = emptyMemory();
  for (let i = 0; i < 60; i++) m = rememberAirplay(m, start(i));
  assert.equal(m.recent.length, 48);
  assert.equal(m.recent[0].trackId, 'song-59');
  const same = rememberAirplay(m, start(59));
  assert.equal(same, m);
});

test('show phase uses actual boundary proximity; no forced crescendo', () => {
  assert.equal(showPhaseInfo(t, t - 3*60_000, t + 120*60_000).phase, 'opening');
  assert.equal(showPhaseInfo(t, t - 90*60_000, t + 9*60_000).phase, 'closing');
  assert.equal(showPhaseInfo(t, t - 20*60_000, t + 60*60_000).phase, 'development');
  assert.equal(showPhaseInfo(t, null, null).phase, 'unknown');
});

test('energy trajectory is descriptive and refuses sparse or missing evidence', () => {
  let m = emptyMemory();
  const bands = ['low', 'medium', 'high'];
  for (let i = 0; i < bands.length; i++) m = rememberAirplay(m, {
    eventId: `measure-${i}`, showId: 'freeform', at: t + i * 180_000,
    trackId: `measured-${i}`, artist: `Artist ${i}`, energy: bands[i],
  });
  assert.equal(musicalMemoryView(m, 'freeform').taggedEnergyTrend, 'rising');
  assert.equal(musicalMemoryView(m, 'other').taggedEnergyTrend, null);
  assert.equal(musicalMemoryView(m, 'freeform').artistConcentration, null);
});

test('an actual reroute retains its intended next step for the next pick', () => {
  let s: DirectionRecord = { ...empty(), pending: { trackId: 'song-1', token: 'a'.repeat(32),
    revision: 0, showId: 'freeform', proposal } };
  s = advanceDirection(s, start(1, 'a'.repeat(32)));
  s = { ...s, pending: { trackId: 'song-2', token: 'b'.repeat(32),
    revision: 0, showId: 'freeform', development: {
      decision: 'reroute', next: 'Lean into new rhythmic territory', alternate: 'Return to ambient textures',
    } } };
  s = advanceDirection(s, start(2, 'b'.repeat(32)));
  assert.equal(s.movement, null, 'rerouting resolves the obsolete movement');
  assert.equal(s.memory?.resolved[0].outcome, 'rerouted');
  assert.equal(s.memory?.resolved[0].followOn, 'Lean into new rhythmic territory');
  assert.equal(musicalMemoryView(s.memory!, 'freeform').recentMovements[0].alternate, 'Return to ambient textures');
});
