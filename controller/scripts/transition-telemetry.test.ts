import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const picker = readFileSync(resolve(here, '../src/music/picker.ts'), 'utf8');
const agent = readFileSync(resolve(here, '../src/broadcast/dj-agent.ts'), 'utf8');
const queue = readFileSync(resolve(here, '../src/broadcast/queue.ts'), 'utf8');
const events = readFileSync(resolve(here, '../src/observability/events.ts'), 'utf8');

function section(source: string, start: string, end: string) {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `missing ${start}`);
  const stop = source.indexOf(end, at);
  return source.slice(at, stop >= 0 ? stop : undefined);
}

test('telemetry uses the existing durable event primitive', () => {
  assert.match(agent, /logEvent\('pick\.decision'/);
  assert.match(agent, /withTrace\(\{ kind: 'track-event'/);
  assert.match(events, /logEvent\('trace\.start'/);
  assert.match(events, /traceId: trace\?\.traceId/);
});

test('soft ranking retains exactly one existing RNG draw per candidate', () => {
  const rank = section(picker, 'function softRankByCompat', '// Show music-steering');
  assert.equal((rank.match(/Math\.random\(/g) || []).length, 1);
  assert.match(rank, /const randomBase = Math\.random\(\)/);
  assert.match(rank, /finalScore: score/);
});

test('soft rank formula keeps BPM, key, freshness, and offered penalty terms', () => {
  const rank = section(picker, 'function softRankByCompat', '// Show music-steering');
  assert.match(rank, /bpmContribution = 0\.4 \* bpmCompat/);
  assert.match(rank, /keyContribution = 0\.3 \* keyCompat/);
  assert.match(rank, /freshnessContribution: fresh/);
  assert.match(rank, /offeredPenalty: penalty/);
  assert.match(rank, /const score = randomBase \+ compat \+ fresh - penalty/);
});

test('rank metadata is attached after the same score is computed', () => {
  const rank = section(picker, 'function softRankByCompat', '// Show music-steering');
  assert.ok(rank.indexOf('const score =') < rank.indexOf('softRankTelemetry.set'));
  assert.ok(rank.indexOf('softRankTelemetry.set') < rank.indexOf('return { t, score }'));
});

test('pool telemetry is observational metadata returned with the existing result', () => {
  assert.match(picker, /candidateSources: sources/);
  assert.match(picker, /candidateCount: candidates\.length/);
  assert.match(picker, /decisionPath: 'pool_fallback_llm_error'/);
  assert.match(picker, /decisionPath: 'pool_fallback_invalid_id'/);
  assert.match(picker, /'pool_repaired'/);
  assert.match(agent, /\|\| 'pool_llm'/);
});

test('telemetry does not add a query to the pool path', () => {
  const before = picker.slice(0, picker.indexOf('export async function pickViaPool'));
  assert.doesNotMatch(before, /pick\.decision/);
  assert.match(picker, /const telemetry = \(chosen\?: Candidate\)/);
  assert.match(picker, /telemetry\(chosen\)/);
});

test('agent success and salvage paths have normalized names', () => {
  assert.match(agent, /let decisionPath = 'agent'/);
  assert.match(agent, /decisionPath = 'agent_repaired'/);
  assert.match(agent, /decisionPath = 'agent_repick'/);
  assert.match(agent, /selectionPath: 'agent'/);
});

test('pool fallbacks retain the first candidate and report the fallback reason', () => {
  assert.match(picker, /song: candidates\[0\]/);
  assert.match(picker, /reason: 'fallback \(LLM pick failed\)'/);
  assert.match(picker, /reason: 'fallback \(LLM returned invalid id\)'/);
  assert.match(agent, /fallbackReason: String\(result\.decisionPath \|\| ''\)\.startsWith\('pool_fallback'\)/);
});

test('near-miss repair remains before final result telemetry', () => {
  const pool = section(picker, 'let chosen = candidates.find', 'return {\n    song: chosen');
  assert.match(pool, /nearestId/);
  assert.ok(pool.indexOf('nearestId') < pool.indexOf('decisionPath'));
});

test('empty-pool outcome remains a no-candidate path', () => {
  assert.match(picker, /if \(candidates\.length === 0\)/);
  assert.match(agent, /decisionPath: 'pool_no_candidates'/);
});

test('pair-drain predecessor and prior context are passed unchanged', () => {
  assert.match(queue, /predecessor: predecessorItem\?\.track \?\? null/);
  assert.match(queue, /prior: predecessorItem \? \(this\.current\?\.track \?\? null\) : null/);
  assert.match(agent, /predecessorOverride: !!predecessor/);
  assert.match(agent, /priorTrackId: prior\?\.id \?\? null/);
});

test('strict show and playlist context remain source values', () => {
  assert.match(agent, /playlistStrict: !!show\?\.playlistStrict/);
  assert.match(agent, /filtersStrict: !!show\?\.filtersStrict/);
  assert.match(picker, /playlistResolved: !!playlistPool/);
  assert.match(picker, /strictGenreResolvedCount: strictGenreResolution\.genres\.length/);
});

test('budget coast is observable without entering selection', () => {
  const budget = section(agent, 'if (!budget.picksAllowed())', 'const cheap = budget.preferCheapPicker');
  assert.match(budget, /decisionPath: 'budget_coast'/);
  assert.doesNotMatch(budget, /pickViaPool|pickViaAgent/);
});

test('event logging remains best effort', () => {
  const body = section(events, 'export function logEvent', '// Delete event day-files');
  assert.match(body, /try \{/);
  assert.match(body, /catch \{/);
  assert.match(body, /Logging must never break a broadcast/);
});

test('no telemetry event contains prompt or candidate payload fields', () => {
  const emitted = section(agent, 'function emitPickDecision', '// Re-exported');
  assert.doesNotMatch(emitted, /prompt|messages|candidates:/);
  assert.match(emitted, /logEvent\('pick\.decision'/);
});

test('station programming modules are not touched by the patch', () => {
  assert.doesNotMatch(agent, /station\/the-lab|schedule-v5\.1/);
  assert.doesNotMatch(picker, /station\/the-lab|schedule-v5\.1/);
});
