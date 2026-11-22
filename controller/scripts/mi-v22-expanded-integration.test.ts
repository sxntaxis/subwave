/** Offline, deterministic checks for the opt-in high-context DJ controls. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airtimePickerTimeoutMs, airtimeSnapshotValid, captureAirtimeSnapshot,
  AIRTIME_COMMIT_RESERVE_SEC } from '../src/broadcast/dj-agent/airtime-reasoning.js';
import { recentMusicalArc } from '../src/broadcast/dj-agent/musical-arc.js';
import { discoveryStepsFor } from '../src/llm/internal/provider/capabilities.js';
import { searchEligibleCohortPage } from '../src/music/music-evidence-cohort.js';
import type { QueueItem } from '../src/broadcast/queue/types.js';

function item(id: string, duration = 120, startedAt?: string): QueueItem {
  return { track: { id, title: id, artist: 'fixture', duration }, ...(startedAt ? { startedAt } : {}) };
}
function queue(current: QueueItem | null, upcoming: QueueItem[] = [], remaining = 120, till = 0) {
  return { current, upcoming, remainingSecOnAir: () => remaining,
    remainingUntilItemAirs: () => till };
}

test('observed remaining air time, not total duration, sets picker reasoning runway', () => {
  const current = item('currently-airing', 600, '2026-11-21T22:00:00Z');
  assert.equal(airtimePickerTimeoutMs(queue(current, [], 120), { kind: 'current', item: current }),
    (120 - AIRTIME_COMMIT_RESERVE_SEC) * 1000);
  assert.equal(airtimePickerTimeoutMs(queue(current, [], 360), { kind: 'current', item: current }), 300_000);
  assert.equal(airtimePickerTimeoutMs(queue(current, [], 35), { kind: 'current', item: current }), 0);
  const unknown = { ...queue(current), remainingSecOnAir: () => null };
  assert.equal(airtimePickerTimeoutMs(unknown, { kind: 'current', item: current }), null);
});

test('held-tail slot uses queued track effective span and invalidates on queue/show change', () => {
  const current = item('current', 120, '2026-11-21T22:00:00Z');
  const held = item('held', 240);
  held.cueInSec = 15;
  held.cueOutSec = 175;
  const q = queue(current, [held], 50, 60);
  const target = { kind: 'held-tail' as const, item: held };
  assert.equal(airtimePickerTimeoutMs(q, target), (60 + 160 - AIRTIME_COMMIT_RESERVE_SEC) * 1000);
  const snapshot = captureAirtimeSnapshot(q, target, 'show-A');
  assert.equal(airtimeSnapshotValid(snapshot, q, 'show-A'), true);
  assert.equal(airtimeSnapshotValid(snapshot, q, 'show-B'), false);
  q.upcoming.push(item('unexpected'));
  assert.equal(airtimeSnapshotValid(snapshot, q, 'show-A'), false);
});

test('historical musical arc has only started items, newest first, no guessed metadata', () => {
  const current = item('now', 160, '2026-11-21T22:00:00Z');
  current.track.bpm = 111;
  const played = item('older', 200, '2026-11-21T21:56:00Z');
  const unplayed = item('not-a-play', 300);
  const arc = recentMusicalArc(current, [played, unplayed]);
  assert.deepEqual(arc.map(r => r.title), ['now', 'older']);
  assert.equal(arc[0].bpm, 111);
  assert.equal('bpm' in arc[1], false);
});

test('wide discovery applies only to explicitly expanded chatgpt-plan picker', () => {
  assert.equal(discoveryStepsFor({ provider: 'chatgpt-plan' }), 3);
  assert.equal(discoveryStepsFor({ provider: 'chatgpt-plan' }, true), 16);
  assert.ok(discoveryStepsFor({ provider: 'ollama' }, true) <= 5);
});

const prefs = [{ family: 'arousal' as const, key: 'value', direction: 'high' as const }];
const makeRow = (id: string, score: number) => ({ id, tier: 'full' as const,
  score, evidenceCoverage: 1, matchedPreferences: 1, requestedPreferences: 1 });

test('strict cohort pagination preserves global ranking across physical chunks', async () => {
  const ids = Array.from({ length: 300 }, (_, i) => `fixture-${i}`);
  const revision = `${'a'.repeat(64)}:123`;
  const search = async (request: { eligibleIds: string[]; offset: number; limit: number; revision?: string }) => {
    if (request.revision && request.revision !== revision) return { status: 'stale' as const,
      results: [], rankedCount: 0, rejectedFreshness: 0, nextOffset: null, revision };
    const ranked = request.eligibleIds.map(id => makeRow(id, Number(id.split('-')[1]) / 300))
      .sort((a,b) => b.score - a.score);
    const results = ranked.slice(request.offset, request.offset + request.limit);
    return { status: 'ok' as const, results, rankedCount: ranked.length, rejectedFreshness: 0,
      checkedCount: results.length, nextOffset: request.offset + results.length < ranked.length
        ? request.offset + results.length : null, revision };
  };
  const now = () => 0;
  const first = await searchEligibleCohortPage(ids, prefs, search, 1000, 0, 12, undefined, now);
  assert.equal(first.status, 'complete');
  if (first.status !== 'complete') return;
  assert.deepEqual(first.results.map(r => r.id), ids.slice(-12).reverse());
  assert.equal(first.nextOffset, 12);
  const second = await searchEligibleCohortPage(ids, prefs, search, 1000, 12, 12, first.revision, now);
  assert.equal(second.status, 'complete');
  if (second.status !== 'complete') return;
  assert.deepEqual(second.results.map(r => r.id), ids.slice(-24, -12).reverse());
  const changed = await searchEligibleCohortPage(ids, prefs,
    async req => ({ ...(await search(req)), status: 'stale' as const }),
    1000, 12, 12, first.revision, now);
  assert.deepEqual(changed, { status: 'incomplete', reason: 'stale' });
});
