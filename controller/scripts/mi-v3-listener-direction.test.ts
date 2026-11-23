import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceDirection, empty } from '../src/broadcast/dj-agent/music-direction-core.js';
import { MusicDirectionStore } from '../src/broadcast/dj-agent/music-direction.js';
import { editorialListenerExpression, rememberListenerExpression, takeListenerExpression } from '../src/broadcast/dj-agent/listener-expression.js';
import { directorV3GroundingCheck, directorV3ListenerSchema, validDirectorListenerReading } from '../src/broadcast/dj-agent/director-v3-core.js';

const FLAGS = ['SUBWAVE_MUSIC_DIRECTION_V1', 'SUBWAVE_MUSIC_DIRECTOR_V2',
  'SUBWAVE_MUSIC_TRAJECTORY_V1', 'SUBWAVE_MI_DIRECTOR_V3'] as const;
const now = Date.now();
const start = (eventId: string, trackId: string, source: 'listener' | 'auto' | 'admin' = 'listener') => ({
  eventId, trackId, source, title: trackId, artist: 'Some artist', showId: 'Freeform',
  at: now, listenerExpression: source === 'listener' ? 'I feel restless; take me somewhere softer' : undefined,
});

test('listener expression is bounded, redacted, ephemeral and consumed exactly once', () => {
  const raw = 'I need a calm piano song, write me at demo@example.org or https://example.org';
  assert.equal(editorialListenerExpression(raw)?.includes('demo@example.org'), false);
  assert.equal(editorialListenerExpression(raw)?.includes('https://'), false);
  assert.equal(editorialListenerExpression('a'.repeat(600))?.length, 280);
  assert.equal(editorialListenerExpression('  '), null);
  rememberListenerExpression('accepted-1', raw, 1000);
  assert.equal(takeListenerExpression('wrong-id', 1100), null);
  assert.match(takeListenerExpression('accepted-1', 1100) || '', /calm piano song/);
  assert.equal(takeListenerExpression('accepted-1', 1200), null);
  rememberListenerExpression('expired-1', raw, 1000);
  assert.equal(takeListenerExpression('expired-1', 1000 + 6 * 60 * 60_000 + 1), null);
});

test('verified listener start retains the words transiently, without replacing the human anchor', () => {
  let state = advanceDirection(empty(), { ...start('ev-1', 'track-1'), directorV2: true, directorV3: true });
  assert.equal(state.steering?.source, 'listener');
  assert.equal(state.steering?.kind, 'song-anchor');
  assert.equal(state.steering?.listenerExpression, 'I feel restless; take me somewhere softer');
  assert.match(state.steering?.intent ?? '', /^Listener-selected track:/);
  const legacy = advanceDirection(empty(), { ...start('legacy', 'track-1'), directorV2: true });
  assert.match(legacy.steering?.intent ?? '', /^Continue naturally from/);
  const previous = state.steering?.id;
  state = advanceDirection(state, { ...start('ev-1', 'track-1'), directorV2: true, directorV3: true });
  assert.equal(state.steering?.id, previous);
  state = advanceDirection(state, { ...start('ev-2', 'track-2', 'auto'), at: now + 1000, directorV2: true, directorV3: true });
  assert.equal(state.steering?.listenerExpression, 'I feel restless; take me somewhere softer');
});

test('Director listener response requires valid bounded reading and verified evidence references', () => {
  const response = directorV3ListenerSchema.parse({
    interpretation: 'A gentler emotional landing', next: 'Acoustic piano then an airy vocal',
    energy: 'release', reason: 'H1 measured arousal and C2 piano instrumentation',
  });
  assert.equal(directorV3GroundingCheck(response, ['H1', 'C2']), true);
  assert.equal(directorV3GroundingCheck({ ...response, reason: 'an organic drift' }, ['H1','C2']), false);
  assert.equal(validDirectorListenerReading({ ...response, next: 'x'.repeat(500) })?.next.length, 400);
  assert.equal(validDirectorListenerReading({ ...response, interpretation: ' ' }), null);
});

test('listener reading commits only for exact verified start/anchor and persists no request text', () => {
  const old = Object.fromEntries(FLAGS.map(key => [key, process.env[key]]));
  for (const key of FLAGS) process.env[key] = '1';
  const dir = mkdtempSync(join(tmpdir(), 'mi-v3-listener-'));
  const path = join(dir, 'direction.json');
  try {
    const store = new MusicDirectionStore(path, true);
    store.onTrackStarted({ ...start('ev-1', 'track-1'), directorV2: true, directorV3: true });
    const snapshot = store.snapshot('Freeform');
    assert.equal(snapshot?.steering?.source, 'listener');
    const parsed = {
      interpretation: 'They want a lower-pressure atmosphere', next: 'Less percussion, acoustic textures',
      energy: 'release', reason: 'H1 arousal and C2 instrumental score point toward a softer option',
    };
    const args = { eventId: 'ev-1', trackId: 'track-1', showId: 'Freeform', at: now,
      expectedRevision: snapshot!.revision, steeringId: snapshot!.steering!.id, output: parsed };
    assert.equal(store.commitListenerReading({ ...args, eventId: 'wrong-event' }), false);
    assert.equal(store.commitListenerReading({ ...args, trackId: 'wrong-song' }), false);
    assert.equal(store.commitListenerReading({ ...args, steeringId: 'wrong-steer' }), false);
    assert.equal(store.commitListenerReading({ ...args, showId: 'Other' }), false);
    assert.equal(store.commitListenerReading(args), true);
    assert.equal(store.commitListenerReading(args), false, 'one writer per verified event');
    assert.equal(store.snapshot('Freeform')?.steering?.listenerReading?.next, parsed.next);
    const disk = readFileSync(path, 'utf8');
    assert.ok(!disk.includes('I feel restless'), 'raw expression must never enter the durable state');
    assert.ok(disk.includes('Less percussion'));
    const loaded = new MusicDirectionStore(path, true).snapshot('Freeform');
    assert.equal(loaded?.steering?.listenerExpression, undefined);
    assert.equal(loaded?.steering?.listenerReading?.interpretation, parsed.interpretation);
    store.setAdmin({ kind: 'pivot', intent: 'Operator direction wins', scope: 'station', showId: 'Freeform' });
    assert.equal(store.commitListenerReading({ ...args, expectedRevision: store.revision() }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const key of FLAGS) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
  }
});
