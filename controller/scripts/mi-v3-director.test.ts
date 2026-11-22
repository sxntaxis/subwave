import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directorV3Due, validDirectorSeed, validDirectorReview, movementClock } from '../src/broadcast/dj-agent/director-v3-core.js';
import { MusicDirectionStore } from '../src/broadcast/dj-agent/music-direction.js';
import { approvedCulturalFeed } from '../src/broadcast/dj-agent/director-v3-research.js';

function movementFixture(now = Date.now()) {
  return {
    id: 'm1', showId: 'A', startedAt: new Date(now - 20 * 60_000).toISOString(),
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    movement: 'Warm movement', destination: 'Soft landing', next: 'Ease the pulse',
    energy: 'release' as const, originRevision: 0, plannedBy: 'director-v3' as const,
    progress: { starts: 4, elapsedMinutes: 20, lastAt: new Date(now).toISOString(),
      lastTrackId: 'track-4', distinctArtists: 4, phase: 'developing' as const, alternate: null },
    lastDecision: { decision: 'seed' as const, starts: 1, eventId: 'ev1',
      at: new Date(now - 16 * 60_000).toISOString(), reason: 'Opening plan' },
  };
}

test('movement timing shows elapsed clock, not musical completion', () => {
  const now = Date.now();
  assert.deepEqual(movementClock({ startedAt: new Date(now - 10 * 60_000).toISOString(),
    expiresAt: new Date(now + 20 * 60_000).toISOString() }, now),
    { elapsedMinutes: 10, remainingMinutes: 20, totalMinutes: 30, percentElapsed: 33 });
  assert.equal(movementClock({ startedAt: 'bad', expiresAt: 'bad' }, now), null);
});

test('independent Director does not override human, request, unknown ID, or pre-v3 movement', () => {
  const now = Date.now();
  const base = { movement: null, steering: null, now, minutesToBoundary: 50,
    source: 'auto' as const, trackId: 'id1' };
  assert.equal(directorV3Due(base), 'seed');
  assert.equal(directorV3Due({ ...base, minutesToBoundary: 14 }), null);
  assert.equal(directorV3Due({ ...base, source: 'listener' }), null);
  assert.equal(directorV3Due({ ...base, trackId: null }), null);
  assert.equal(directorV3Due({ ...base, steering: { source: 'admin' } as any }), null);
  assert.equal(directorV3Due({ ...base, movement: { ...movementFixture(now), plannedBy: undefined } }), null);
});

test('review cadence is bounded by distinct verified starts and elapsed time', () => {
  const now = Date.now();
  const base = { movement: movementFixture(now), steering: null, now,
    minutesToBoundary: 9, source: 'auto' as const, trackId: 'id4' };
  assert.equal(directorV3Due(base), 'review');
  assert.equal(directorV3Due({ ...base,
    movement: { ...base.movement!, lastDecision: { ...base.movement!.lastDecision,
      at: new Date(now - 2 * 60_000).toISOString() } } }), null);
  assert.equal(directorV3Due({ ...base, movement: { ...base.movement!,
    progress: { ...base.movement!.progress, starts: 2 } } }), 'review');
});

test('proposal validation refuses ungrounded horizons, malformed intent, and absent review steps', () => {
  const seed = { action: 'seed', movement: 'A', destination: 'B', next: 'C', horizonMinutes: 30, energy: 'release' };
  assert.equal(validDirectorSeed(seed, 19)?.horizonMinutes, 19);
  assert.equal(validDirectorSeed(seed, 14), null);
  assert.equal(validDirectorSeed({ ...seed, destination: '' }, 50), null);
  assert.equal(validDirectorSeed({ ...seed, action: 'defer' }, 50), null);
  assert.equal(validDirectorSeed({ ...seed, horizonMinutes: NaN }, 50), null);
  assert.equal(validDirectorReview({ decision: 'continue', next: 'Go', alternate: 'Or this' })?.decision, 'continue');
  assert.equal(validDirectorReview({ decision: 'improvise', next: 'Go', alternate: 'Or this' }), null);
});

test('store permits only latest verified start to seed/review, and preserves human authority', () => {
  const old = { d: process.env.SUBWAVE_MUSIC_DIRECTION_V1, v2: process.env.SUBWAVE_MUSIC_DIRECTOR_V2,
    tr: process.env.SUBWAVE_MUSIC_TRAJECTORY_V1, v3: process.env.SUBWAVE_MI_DIRECTOR_V3 };
  Object.assign(process.env, { SUBWAVE_MUSIC_DIRECTION_V1: '1', SUBWAVE_MUSIC_DIRECTOR_V2: '1',
    SUBWAVE_MUSIC_TRAJECTORY_V1: '1', SUBWAVE_MI_DIRECTOR_V3: '1' });
  const dir = mkdtempSync(join(tmpdir(), 'mi-v3-director-'));
  const store = new MusicDirectionStore(join(dir, 'music-direction.json'), true);
  const now = Date.now();
  const start = (eventId: string, id: string, source: 'auto' | 'admin' = 'auto') => store.onTrackStarted({
    eventId, trackId: id, showId: 'A', title: id, artist: id, source, at: now,
    queueToken: null, energy: 'medium', moods: ['warm'], genre: 'folk',
  });
  try {
    start('ev1', 'song1');
    const revision = store.revision();
    const output = { action: 'seed', movement: 'Acoustic turns', destination: 'A warmer pulse',
      next: 'Ease the rhythm', energy: 'hold', horizonMinutes: 30,
      reason: 'The current show and the verified starts support a steady opening' };
    const args = { eventId: 'ev1', trackId: 'song1', showId: 'A', at: now,
      expectedRevision: revision, expectedMovementId: null, remainingMinutes: 34,
      action: 'seed' as const, output };
    assert.equal(store.commitDirectorV3({ ...args, eventId: 'not-a-start' }), false);
    assert.equal(store.commitDirectorV3(args), true);
    const m = store.snapshot('A')?.movement;
    assert.equal(m?.plannedBy, 'director-v3');
    assert.equal(m?.lastDecision?.decision, 'seed');
    assert.equal(store.commitDirectorV3(args), false);
    start('ev2', 'song2');
    assert.equal(store.commitDirectorV3({ ...args, expectedMovementId: m?.id ?? null,
      action: 'review', output: { decision: 'continue', next: 'Continue', alternate: 'Else', reason: 'Observed a match' } }), false);
    assert.equal(store.commitDirectorV3({ ...args, eventId: 'ev2', trackId: 'song2',
      expectedMovementId: m?.id ?? null, action: 'review',
      output: { decision: 'continue', next: 'Continue', alternate: 'Else', reason: 'Observed a match' } }), true);
    assert.equal(store.snapshot('A')?.movement?.lastDecision?.decision, 'continue');
    start('ev3', 'admin-song', 'admin');
    assert.equal(store.snapshot('A')?.movement, null);
    assert.equal(store.commitDirectorV3({ ...args, eventId: 'ev3', trackId: 'admin-song' }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries({ SUBWAVE_MUSIC_DIRECTION_V1: old.d,
      SUBWAVE_MUSIC_DIRECTOR_V2: old.v2, SUBWAVE_MUSIC_TRAJECTORY_V1: old.tr,
      SUBWAVE_MI_DIRECTOR_V3: old.v3 })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('cultural research is explicit HTTPS only, never agent-selected local addresses', () => {
  assert.equal(approvedCulturalFeed('https://culture.example.org/rss'), 'https://culture.example.org/rss');
  for (const url of ['http://culture.example.org/rss','https://localhost/rss',
    'https://127.0.0.1/rss','https://host.local/feed','file:///etc/passwd']) {
    assert.equal(approvedCulturalFeed(url), null);
  }
});
