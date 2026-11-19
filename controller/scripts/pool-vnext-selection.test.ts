import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composePoolSelection, withPoolAcousticReaderForTest } from '../src/music/pool-selection.js';
import type { IndexedAcousticRow } from '../src/music/library-db/acoustic-index.js';
import type { PickerSelectionObservation } from '../src/observability/picker-audit.js';
import { filterPickerCandidates } from '../src/music/recency.js';

const candidates = Array.from({ length: 12 }, (_, i) => ({ id: `track-${i}`, artist: `artist-${i}` }));
const context = { predecessorId: 'anchor', recentAiredIds: [] as string[] };
const pace = (n: number) => JSON.stringify([0, 1, 2].map(i => ({ startMs: i * 1000, endMs: (i + 1) * 1000, value: n })));
const row = (id: string, good: boolean): IndexedAcousticRow => ({
  id, track: { bpm: good ? 80 : 133, musical_key: good ? '8A' : '2B',
    pace_json: pace(good ? 0.1 : 0.9), key_ranges_json: null, duration_sec: 180 },
  vector: new Float32Array(good ? [1, 0] : [-1, 0]),
});
const reader = async (ids: readonly string[]) => ids.map(id =>
  row(id, id === 'anchor' || Number(id.slice(6)) >= 8));

test('Pool composition changes legal offer order without adding or losing candidates', async () => {
  const observations: PickerSelectionObservation[] = [];
  const out = await withPoolAcousticReaderForTest(reader,
    () => composePoolSelection(candidates, context, x => observations.push(x)));
  assert.deepEqual(new Set(out.map(c => c.id)), new Set(candidates.map(c => c.id)));
  assert.notDeepEqual(out, candidates);
  assert.equal(observations[0].reason, 'scored_no_membership_change');
  assert.equal(observations[0].orderedShortlistChanged, true);
});

test('cold, missing context, missing flow, ceiling and deadline retain the exact input', async () => {
  for (const [input, ctx, lookup, expected] of [
    [candidates, undefined, reader, 'no_eligible_context'],
    [candidates, context, async () => null, 'index_unavailable'],
    [candidates, context, async (ids: readonly string[]) => ids.map(id => ({ id, track: null, vector: null })), 'missing_predecessor_evidence'],
    [candidates, context, async (ids: readonly string[]) => ids.map(id => ({
      id, track: { bpm: null, musical_key: null, pace_json: null, key_ranges_json: null, duration_sec: 180 }, vector: null,
    })), 'missing_flow'],
    [candidates, context, async (ids: readonly string[]) => ids.map(id => ({
      id, get track(): never { throw new Error('fixture'); }, vector: null,
    })), 'scorer_exception'],
    [Array.from({ length: 257 }, (_, i) => ({ id: `id-${i}`, artist: `artist-${i}` })), context, reader, 'candidate_ceiling'],
    [candidates, context, async () => new Promise<IndexedAcousticRow[] | null>(() => {}), 'deadline_or_budget'],
  ] as const) {
    const seen: PickerSelectionObservation[] = [];
    const result = await withPoolAcousticReaderForTest(lookup, () =>
      composePoolSelection(input, ctx, x => seen.push(x)));
    assert.equal(result, input);
    assert.equal(seen[0].reason, expected);
  }
});

test('a scored unchanged offer is reported without an invented change', async () => {
  const observations: PickerSelectionObservation[] = [];
  const single = candidates.slice(0, 1);
  const out = await withPoolAcousticReaderForTest(reader,
    () => composePoolSelection(single, context, x => observations.push(x)));
  assert.deepEqual(out, single);
  assert.equal(observations[0].reason, 'scored_no_membership_change');
  assert.equal(observations[0].orderedShortlistChanged, false);
});

test('composition cannot reintroduce hard-recency, seen or off-playlist tracks', async () => {
  const playlist = new Set(candidates.slice(0, 10).map(c => c.id));
  const eligible = filterPickerCandidates(candidates.filter(c => playlist.has(c.id)), {
    hardRecentIds: new Set(['track-0']), seenIds: new Set(['track-1']),
  });
  const result = await withPoolAcousticReaderForTest(reader, () => composePoolSelection(eligible, context));
  assert.deepEqual(new Set(result.map(c => c.id)), new Set(eligible.map(c => c.id)));
  assert.ok(result.every(c => playlist.has(c.id) && c.id !== 'track-0' && c.id !== 'track-1'));
  assert.equal(new Set(result.map(c => c.id)).size, result.length);
  const duplicate = [candidates[0], candidates[0]];
  assert.equal(await withPoolAcousticReaderForTest(reader, () => composePoolSelection(duplicate, context)), duplicate);
});
