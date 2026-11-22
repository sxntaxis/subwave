import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MusicDirectionStore } from '../src/broadcast/dj-agent/music-direction.js';

test('operator direction persists privately across restart; speculative picks do not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-v23-direction-'));
  try {
    const file = join(dir, 'direction.json');
    const store = new MusicDirectionStore(file, true);
    const applied = store.setAdmin({ kind: 'pivot', intent: 'Explore more rhythmic material',
      scope: 'station', showId: 'first' }, Date.UTC(2026, 10, 21));
    assert.equal(applied?.steering?.kind, 'pivot');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pending, null);
    const rev = store.revision();
    assert.equal(store.offerProposal('song', rev, 'first', {
      movement: 'soft', destination: 'bright', next: 'build', horizonMinutes: 20, energy: 'build',
    }), true);
    const recovered = new MusicDirectionStore(file, true);
    assert.equal(recovered.revision(), rev);
    assert.equal(recovered.snapshot('other')?.steering?.intent, 'Explore more rhythmic material');
    assert.equal(recovered.snapshot('other')?.movement, null);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pending, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mixer start identity is persisted and makes repeated watcher starts idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-v23-direction-'));
  try {
    const file = join(dir, 'direction.json');
    const store = new MusicDirectionStore(file, true);
    const at = Date.UTC(2026, 10, 21);
    const start = { eventId: 'mixer:170001', trackId: 'song', title: 'Song', artist: 'Artist',
      source: 'listener' as const, showId: 'show', at };
    store.onTrackStarted(start);
    const first = store.snapshot('show', at);
    const restored = new MusicDirectionStore(file, true);
    assert.equal(restored.alreadyObservedStart(start.eventId), true);
    restored.onTrackStarted(start);
    assert.equal(restored.snapshot('show', at)?.steering?.id, first?.steering?.id);
    assert.equal(restored.snapshot('show', at)?.steering?.remainingStarts, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
