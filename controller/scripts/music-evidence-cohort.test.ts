import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchEligibleCohort } from '../src/music/music-evidence-cohort.js';
import { rankMusicCandidates } from '../src/music/music-joint-ranking.mjs';

test('eligible chunks merge like whole-cohort ranking including ties', async () => {
  const ids = Array.from({ length: 300 }, (_, i) => `id-${String(i).padStart(3, '0')}`);
  const preferences = [{ family: 'instrument' as const, key: 'piano', direction: 'high' as const }];
  const candidates = ids.map((id, i) => ({ id, values: { instrument: { piano: i === 289 ? 1 : 0.5 } } }));
  const expected = rankMusicCandidates(candidates, preferences)!.slice(0, 12);
  const chunks: number[] = [];
  const response = await searchEligibleCohort(ids, preferences, async request => {
    chunks.push(request.eligibleIds.length);
    const allowed = new Set(request.eligibleIds);
    const ranked = rankMusicCandidates(candidates.filter(c => allowed.has(c.id)), preferences)!;
    return { results: ranked.slice(0, request.limit), rankedCount: ranked.length, rejectedFreshness: 0 };
  }, performance.now() + 3000);
  assert.equal(response.status, 'complete');
  if (response.status !== 'complete') return;
  assert.deepEqual(chunks, [128, 128, 44]);
  assert.deepEqual(response.results, expected);
  assert.equal(response.results[0].id, 'id-289');
});

test('an unsearched or freshness-limited chunk returns incomplete, never partial results', async () => {
  const ids = Array.from({ length: 200 }, (_, i) => `id-${i}`);
  const preferences = [{ family: 'arousal' as const, key: 'value', direction: 'low' as const }];
  let calls = 0;
  const result = await searchEligibleCohort(ids, preferences, async () => {
    calls++;
    return calls === 1 ? { results: [], rankedCount: 0, rejectedFreshness: 0 } : null;
  }, performance.now() + 3000);
  assert.deepEqual(result, { status: 'incomplete', reason: 'unavailable' });
  const limited = await searchEligibleCohort(['a'], preferences, async () => ({
    results: [], rankedCount: 129, rejectedFreshness: 128, verificationLimited: true,
  }), performance.now() + 3000);
  assert.deepEqual(limited, { status: 'incomplete', reason: 'verification_limited' });
  const timed = await searchEligibleCohort(['a'], preferences, () => new Promise(() => {}), performance.now() + 10);
  assert.deepEqual(timed, { status: 'incomplete', reason: 'deadline' });
});
