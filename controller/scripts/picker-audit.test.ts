import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendPickerAuditEvent, classifyPickerFailure, createPickerAuditRecorder, observeV2QueueStart,
  type PickerAuditEvent,
} from '../src/observability/picker-audit.js';
import compareMusicalCandidates from '../src/llm/internal/tools/picker/tools/compare-musical-candidates.js';

const NOW = () => new Date('2026-11-18T12:34:56.000Z');

test('off mode performs no candidate capture or write', () => {
  const events: PickerAuditEvent[] = [];
  const audit = createPickerAuditRecorder('pool', 'show-fixture', null, {
    enabled: false, attemptId: 'trace-fixture', now: NOW, write: event => events.push(event),
  });
  assert.equal(audit.agentDiagnosticsObserver(), undefined);
  audit.captureCandidates(['one', 'two']);
  audit.captureSelection({
    reason: 'scored_membership_change', eligibleCandidates: 2, offeredCandidates: 1,
  });
  audit.finish({ outcome: 'success', chosenId: 'one' });
  audit.finish({
    outcome: 'error',
    failure: classifyPickerFailure(Object.assign(new Error('private error text'), { statusCode: 503 }), 12),
  });
  assert.deepEqual(events, []);
});

test('Agent failure classification is finite, sanitized, and leaves unknown phase and retries unknown', () => {
  const provider = Object.assign(new Error('must-not-persist-provider-message'), {
    statusCode: 503,
    code: 'private-provider-code',
  });
  const beforeKeys = Object.getOwnPropertyNames(provider).sort();
  const classified = classifyPickerFailure(provider, 17.6);
  assert.deepEqual(classified, {
    failure_phase: 'unknown',
    failure_category: 'provider_http',
    failure_retry_status: 'unknown',
    failure_http_status: 503,
    failure_elapsed_ms: 18,
  });
  assert.deepEqual(Object.getOwnPropertyNames(provider).sort(), beforeKeys);
  assert.equal(provider.message, 'must-not-persist-provider-message');
  assert.equal(JSON.stringify(classified).includes('must-not-persist'), false);
  assert.equal(JSON.stringify(classified).includes('private-provider-code'), false);

  assert.deepEqual(classifyPickerFailure({ message: 'untrusted free text' }), {
    failure_phase: 'unknown',
    failure_category: 'unknown',
    failure_retry_status: 'unknown',
  });
});

test('deadline classification reports only the known deadline fact and bounds elapsed time', () => {
  const deadline = new Error('private deadline text');
  deadline.name = 'AgentDeadlineError';
  assert.deepEqual(classifyPickerFailure(deadline, 9_000_000), {
    failure_phase: 'unknown',
    failure_category: 'timeout_deadline',
    failure_retry_status: 'unknown',
    failure_elapsed_ms: 600_000,
    failure_deadline_exhausted: true,
  });
});

test('Agent lifecycle observer records only bounded phase, tool, retry and failover facts', () => {
  const events: PickerAuditEvent[] = [];
  const audit = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'lifecycle-fixture', now: NOW, write: event => events.push(event),
  });
  const observer = audit.agentDiagnosticsObserver();
  assert.ok(observer);
  observer.providerGenerationStarted();
  observer.toolStarted();
  observer.toolFinished(true);
  observer.toolStarted();
  observer.toolFinished(false);
  observer.retryAttempted();
  observer.retryExhausted();
  audit.finish({
    outcome: 'error',
    failure: classifyPickerFailure(new Error('private exception')),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].failure_phase, 'tool_invocation_or_result');
  assert.equal(events[0].failure_retry_status, 'unknown');
  assert.equal(events[0].failure_transient_retry_status, 'exhausted');
  assert.equal(events[0].failure_tool_started_count, 2);
  assert.equal(events[0].failure_tool_completed_count, 1);
  assert.equal(events[0].failure_tool_failed_count, 1);
  assert.equal(JSON.stringify(events[0]).includes('private exception'), false);
});

test('failover is recorded separately and retry status resets for the backup leg', () => {
  const events: PickerAuditEvent[] = [];
  const audit = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'failover-fixture', now: NOW, write: event => events.push(event),
  });
  const observer = audit.agentDiagnosticsObserver()!;
  observer.retryAttempted();
  observer.retryExhausted();
  observer.failoverAttempted();
  observer.providerGenerationStarted();
  observer.retryNotAttempted();
  audit.finish({ outcome: 'error', failure: classifyPickerFailure(new Error('private')) });
  assert.equal(events[0].failure_failover_status, 'attempted');
  assert.equal(events[0].failure_retry_status, 'unknown');
  assert.equal(events[0].failure_transient_retry_status, 'not_attempted');
  assert.equal(events[0].failure_phase, 'provider_generation');
});

test('comparison audit stores only outcome, bounded aggregates and attempt correlation', () => {
  const events: PickerAuditEvent[] = [];
  const audit = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'comparison-fixture', now: NOW, write: event => events.push(event),
  });
  audit.noteV2Compare();
  audit.captureV2Comparison({ outcome: 'partial', inputCount: 4, outputCount: 2 });
  audit.finish({ outcome: 'error', failure: classifyPickerFailure(new Error('private')) });
  assert.equal(events[0].attempt_id, 'comparison-fixture');
  assert.deepEqual(events[0].comparison, {
    invocations: 1, outcome: 'partial', input_count: 4, output_count: 2, coverage: 0.5,
  });
  assert.equal(JSON.stringify(events[0].comparison).includes('private'), false);
});

test('comparison audit totals invocations and keeps aggregates scoped to the last result', () => {
  const events: PickerAuditEvent[] = [];
  const audit = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'comparison-last-fixture', now: NOW, write: event => events.push(event),
  });
  audit.noteV2Compare();
  audit.captureV2Comparison({ outcome: 'invoked', inputCount: 2, outputCount: 0 });
  audit.captureV2Comparison({ outcome: 'partial', inputCount: 2, outputCount: 1 });
  audit.noteV2Compare();
  audit.captureV2Comparison({ outcome: 'invoked', inputCount: 4, outputCount: 0 });
  audit.captureV2Comparison({ outcome: 'unavailable', inputCount: 4, outputCount: 0 });
  audit.finish({ outcome: 'error', failure: classifyPickerFailure(new Error('private')) });
  assert.deepEqual(events[0].comparison, {
    invocations: 2, outcome: 'unavailable', input_count: 4, output_count: 0, coverage: 0,
  });
  assert.equal(JSON.stringify(events[0].comparison).includes('fixture'), false);
});

test('an escaping comparator tool error is distinct from returned unavailable evidence', () => {
  const events: PickerAuditEvent[] = [];
  const audit = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'comparison-error-fixture', now: NOW, write: event => events.push(event),
  });
  audit.noteV2Compare();
  audit.captureV2Comparison({ outcome: 'invoked', inputCount: 3, outputCount: 0 });
  audit.agentDiagnosticsObserver()!.toolFinished(false, true);
  audit.finish({ outcome: 'error', failure: classifyPickerFailure(new Error('private')) });
  assert.deepEqual(events[0].comparison, {
    invocations: 1, outcome: 'error', input_count: 3, output_count: 0, coverage: 0,
  });
});

test('comparator return boundary reports success, partial and unavailable aggregates only', async () => {
  const observed: Array<{ outcome: string; inputCount: number; outputCount: number }> = [];
  const row = {
    trackId: 'private-track-id', analysisId: 'private-analysis', runId: 'private-run',
    modelsHash: 'private-models', sourceSize: '1', sourceMtimeNs: '1',
    expectedWindows: 0, windows: [],
  };
  async function execute(rows: Map<string, unknown> | null, reservation = true) {
    const seen = new Map([['private-a', {}], ['private-b', {}]]);
    const tool = compareMusicalCandidates.build({
      scope: { essentiaDiscovery: true, essentiaAudit: {
        noteV2Compare() {},
        captureV2Comparison: value => observed.push(value),
      } },
      seen,
      essentia: { lookupV2: async () => rows } as any,
      reserveMusicEvidence: () => reservation ? { bytes: 16_384, release() {} } : null,
    } as any) as any;
    return tool.execute({ ids: ['private-a', 'private-b'] });
  }
  assert.equal((await execute(new Map([['private-a', row], ['private-b', row]]))).status, 'available');
  assert.equal((await execute(new Map([['private-a', row]]))).status, 'partial');
  assert.equal((await execute(null)).status, 'unavailable');
  assert.equal((await execute(new Map(), false)).status, 'unavailable');
  assert.deepEqual(observed.map(item => item.outcome), [
    'invoked', 'success', 'invoked', 'partial', 'invoked', 'unavailable', 'invoked', 'unavailable',
  ]);
  assert.deepEqual(observed.filter(item => item.outcome !== 'invoked')
    .slice(0, 2).map(({ inputCount, outputCount }) => ({ inputCount, outputCount })), [
    { inputCount: 2, outputCount: 2 }, { inputCount: 2, outputCount: 1 },
  ]);
  assert.equal(JSON.stringify(observed).includes('private-a'), false);
  assert.equal(JSON.stringify(observed).includes('private-track-id'), false);
});

test('pre- and post-tool-shaped errors remain phase-unknown without completed counts or recoverability claims', () => {
  const beforeTool = classifyPickerFailure(new Error('before tool'));
  const afterTool = classifyPickerFailure(Object.assign(new Error('after tool'), {
    steps: [{
      toolCalls: [{ toolName: 'fixtureTool', input: { private: 'argument' } }],
      toolResults: [{ output: { private: 'result' } }],
    }],
  }));
  assert.equal(beforeTool.failure_phase, 'unknown');
  assert.equal(afterTool.failure_phase, 'unknown');
  for (const diagnostics of [beforeTool, afterTool]) {
    assert.equal('tool_calls_completed' in diagnostics, false);
    assert.equal('tool_results_completed' in diagnostics, false);
    assert.equal('usable_result' in diagnostics, false);
    assert.equal(diagnostics.failure_retry_status, 'unknown');
  }
});

test('failed Agent audit event contains only normalized failure fields and candidate count', () => {
  const events: PickerAuditEvent[] = [];
  const raw = Object.assign(new Error('RAW_EXCEPTION_MESSAGE'), {
    statusCode: 502,
    responseText: 'RAW_MODEL_COMPLETION',
    steps: [{
      toolCalls: [{ toolName: 'fixtureTool', input: { secret: 'RAW_TOOL_ARGUMENT' } }],
      toolResults: [{ output: 'RAW_TOOL_RESULT' }],
    }],
  });
  const audit = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'failure-fixture', now: NOW, write: event => events.push(event),
  });
  audit.captureCandidates(['private-candidate-one', 'private-candidate-two', 'private-candidate-one']);
  audit.finish({
    outcome: 'error', fallbackPath: 'pool', fallbackReason: 'agent_run_failed',
    failure: classifyPickerFailure(raw, 23.4),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'error');
  assert.equal(events[0].fallback_reason, 'agent_run_failed');
  assert.equal(events[0].failure_phase, 'unknown');
  assert.equal(events[0].failure_category, 'provider_http');
  assert.equal(events[0].failure_retry_status, 'unknown');
  assert.equal(events[0].failure_http_status, 502);
  assert.equal(events[0].failure_elapsed_ms, 23);
  assert.equal(events[0].seen_candidate_count, 2);
  assert.equal('failure_deadline_exhausted' in events[0], false);
  assert.equal('tool_calls' in events[0], false);
  const diagnosticFields = Object.fromEntries(Object.entries(events[0])
    .filter(([key]) => key.startsWith('failure_') || key === 'seen_candidate_count'));
  const serialized = JSON.stringify(diagnosticFields);
  for (const secret of [
    'RAW_EXCEPTION_MESSAGE', 'RAW_MODEL_COMPLETION', 'RAW_TOOL_ARGUMENT',
    'RAW_TOOL_RESULT', 'private-candidate-one', 'private-candidate-two',
  ]) assert.equal(serialized.includes(secret), false);
  assert.equal('tool_calls_completed' in events[0], false);
  assert.equal('tool_results_completed' in events[0], false);
  assert.equal('usable_result' in events[0], false);
});

test('private selection audit aggregates score versus baseline and separates acoustic search calls', () => {
  const events: PickerAuditEvent[] = [];
  const audit = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'trace-fixture', now: NOW, write: event => events.push(event),
  });
  audit.captureSelection({
    reason: 'scored_membership_change', eligibleCandidates: 20, offeredCandidates: 8,
    lookupMs: 13, orderedShortlistChanged: true,
  });
  audit.captureSelection({
    reason: 'index_unavailable', eligibleCandidates: 12, offeredCandidates: 8,
  });
  audit.finish({ outcome: 'success', toolCalls: 5, acousticSearchToolCalls: 1 });
  assert.deepEqual(events[0].selection, {
    status: 'observed', scored: 1, baseline: 1,
    reasons: { scored_membership_change: 1, index_unavailable: 1 },
    eligible_candidates: 32, offered_candidates: 16, lookup_ms: 13,
    ordered_shortlists_changed: 1,
  });
  assert.equal(events[0].tool_calls, 5);
  assert.equal(events[0].acoustic_search_tool_calls, 1);
  assert.equal(JSON.stringify(events[0]).includes('fixture-track-id'), false);
});

test('v2 audit counts exposure and comparison without claiming queue or airplay', () => {
  const events: PickerAuditEvent[] = [];
  const audit = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'v2-fixture', now: NOW, write: event => events.push(event),
  });
  audit.noteV2Joint(false);
  audit.noteV2Compare();
  audit.captureV2Profiles(['candidate', 'candidate']);
  audit.finish({ outcome: 'success', chosenId: 'candidate' });
  assert.deepEqual(events[0].music_v2, {
    joint_calls: 1, joint_unavailable: 0, compare_calls: 1,
    profile_candidates_exposed: 1, chosen_had_exposed_profile: true,
  });
  const serialized = JSON.stringify(events[0].music_v2);
  assert.equal(serialized.includes('candidate'), true); // field name only, no ID value
  assert.equal(serialized.includes('"candidate"'), false);
  assert.equal(serialized.includes('aired'), false);
  assert.equal(serialized.includes('queued'), false);
});

test('v2 lifecycle separates joint offer, selection, accepted insertion and exact start', () => {
  const events: any[] = [];
  const audit = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'attempt-42', now: NOW, write: event => events.push(event),
  });
  audit.noteV2Joint(false);
  audit.captureV2JointCandidates(['joint-candidate']);
  assert.equal(audit.captureV2Selection('other-tool-candidate'), false);
  const selected = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'attempt-43', now: NOW, write: event => events.push(event),
  });
  selected.noteV2Joint(false);
  selected.captureV2JointCandidates(['joint-candidate']);
  assert.equal(selected.captureV2Selection('joint-candidate'), true);
  const token = 'a'.repeat(32);
  selected.recordV2Enqueued(token);
  assert.equal(observeV2QueueStart('b'.repeat(32), () => {}, true), false);
  assert.equal(observeV2QueueStart(token, attempt => events.push({
    attempt, stage: 'controller_observed_track_start',
  }), true), true);
  assert.equal(observeV2QueueStart(token, () => {}, true), false);
  selected.finish({ outcome: 'success', chosenId: 'joint-candidate' });
  assert.deepEqual(events.filter(event => event.event_type === 'v2_lifecycle').map(event => event.stage), [
    'selected', 'selected', 'enqueued',
  ]);
  assert.deepEqual(events.at(-2), { attempt: 'attempt-43', stage: 'controller_observed_track_start' });
  assert.equal(JSON.stringify(events).includes(token), false, 'private tokens never enter the audit log');
});

test('Essentia summary counts observed distinct exposures and correlates only successful Agent choices', () => {
  const events: PickerAuditEvent[] = [];
  const audit = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'trace-fixture', now: NOW, write: event => events.push(event),
  });
  audit.setEssentiaAvailability(true);
  audit.captureProfileExposure(['one', 'one', 'two']);
  audit.noteTraitInvocation();
  audit.captureTraitResult(['two', 'two'], 'returned');
  audit.finish({ outcome: 'repicked', chosenId: 'two' });
  assert.deepEqual(events[0].essentia, {
    availability: 'available',
    profiled_candidates_exposed: 2,
    trait_tool_invocations: 1,
    trait_candidates_exposed: 1,
    trait_result: 'returned',
    chosen_had_exposed_profile: true,
    chosen_from_trait_result: true,
  });
  assert.equal(JSON.stringify(events[0].essentia).includes('one'), false);

  const failed: PickerAuditEvent[] = [];
  const rejected = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: null, now: NOW, write: event => failed.push(event),
  });
  rejected.setEssentiaAvailability(false);
  rejected.captureProfileExposure([]);
  rejected.noteTraitInvocation();
  rejected.captureTraitResult([], 'unavailable');
  rejected.finish({ outcome: 'fallback', chosenId: 'pool-choice', fallbackPath: 'pool' });
  assert.equal(failed[0].essentia?.chosen_had_exposed_profile, null);
  assert.equal(failed[0].essentia?.chosen_from_trait_result, null);
  assert.equal(failed[0].essentia?.profiled_candidates_exposed, 0);
});

test('an expected but uncalled collector is explicit, never a zero-score claim', () => {
  const events: PickerAuditEvent[] = [];
  const audit = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'trace-fixture', now: NOW, write: event => events.push(event),
  });
  audit.expectSelectionObservation();
  audit.finish({ outcome: 'success', toolCalls: 1, acousticSearchToolCalls: 0 });
  assert.deepEqual(events[0].selection, {
    status: 'not_invoked', reasons: { collector_not_invoked: 1 },
  });
  assert.equal(events[0].acoustic_search_tool_calls, 0);
  assert.equal('scored' in (events[0].selection ?? {}), false);
});

test('agent, pool and auto refresh retain ordered unique IDs and safe outcome fields', () => {
  for (const path of ['agent', 'pool', 'auto_refresh'] as const) {
    const events: PickerAuditEvent[] = [];
    const audit = createPickerAuditRecorder(path, null, new Date('2026-11-18T12:00:00.000Z'), {
      enabled: true, attemptId: 'trace-fixture', now: NOW, write: event => events.push(event),
    });
    audit.setShowId('show-fixture');
    audit.setShowAt(new Date('2026-11-18T12:00:00.000Z'));
    audit.captureCandidates(['one', null, 'two', 'one', undefined]);
    audit.finish({ outcome: 'repaired', chosenId: 'two', toolCalls: 3 });
    audit.finish({ outcome: 'error', fallbackReason: 'must_not_replace_first_record' });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      schema_version: 1,
      timestamp: '2026-11-18T12:34:56.000Z',
      attempt_id: 'trace-fixture',
      path,
      show_id: 'show-fixture',
      show_at: '2026-11-18T12:00:00.000Z',
      candidate_ids: ['one', 'two'],
      chosen_id: 'two',
      outcome: 'repaired',
      tool_calls: 3,
      ...(path === 'agent' ? { essentia: {
        availability: 'not_checked',
        profiled_candidates_exposed: 'not_invoked',
        trait_tool_invocations: 0,
        trait_candidates_exposed: 0,
        trait_result: 'not_invoked',
        chosen_had_exposed_profile: null,
        chosen_from_trait_result: false,
      } } : {}),
    });
  }
});

test('each selector path records a bounded terminal outcome, including failures', () => {
  for (const path of ['agent', 'pool', 'auto_refresh'] as const) {
    for (const outcome of ['success', 'error'] as const) {
      const events: PickerAuditEvent[] = [];
      const audit = createPickerAuditRecorder(path, 'show-fixture', null, {
        enabled: true, attemptId: `trace-${path}`, now: NOW, write: event => events.push(event),
      });
      audit.captureCandidates(outcome === 'error' ? [] : ['fixture-a']);
      audit.finish({ outcome, fallbackPath: outcome === 'error' ? (path === 'auto_refresh' ? 'auto_playlist' : 'pool') : null });
      assert.equal(events.length, 1);
      assert.equal(events[0].path, path);
      assert.equal(events[0].outcome, outcome);
      assert.deepEqual(events[0].candidate_ids, outcome === 'error' ? [] : ['fixture-a']);
      if (path === 'agent') assert.equal(events[0].essentia?.chosen_had_exposed_profile, null);
    }
  }
});

test('writer failures are swallowed and do not mutate selection results', () => {
  const chosen = 'fixture-choice';
  const audit = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: null, now: NOW, write: () => { throw new Error('disk unavailable'); },
  });
  audit.captureCandidates(['fixture-choice', 'fixture-other']);
  assert.doesNotThrow(() => audit.finish({
    outcome: 'error', chosenId: chosen, fallbackPath: 'pool', fallbackReason: 'agent_run_failed',
    failure: classifyPickerFailure(new Error('must-not-escape'), 2),
  }));
  assert.equal(chosen, 'fixture-choice');
});

test('private file writer requires an owner-only directory and creates owner-only JSONL', async () => {
  const parent = await mkdtemp(resolve(tmpdir(), 'picker-audit-test-'));
  const safe = resolve(parent, 'safe');
  const unsafe = resolve(parent, 'unsafe');
  await Promise.all([mkdir(safe, { mode: 0o700 }), mkdir(unsafe, { mode: 0o755 })]);
  try {
    const event: PickerAuditEvent = {
      schema_version: 1,
      timestamp: '2026-11-18T12:34:56.000Z',
      attempt_id: 'trace-fixture',
      path: 'pool',
      show_id: 'show-fixture',
      show_at: null,
      candidate_ids: ['fixture-a'],
      chosen_id: 'fixture-a',
      outcome: 'success',
    };
    await appendPickerAuditEvent(event, safe);
    const file = resolve(safe, 'offers-2026-11-18.jsonl');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse((await readFile(file, 'utf8')).trim()), event);
    await appendPickerAuditEvent(event, unsafe);
    await assert.rejects(stat(resolve(unsafe, 'offers-2026-11-18.jsonl')), { code: 'ENOENT' });
  } finally {
    await chmod(parent, 0o700);
    await rm(parent, { recursive: true, force: true });
  }
});

test('audit-enabled fixture preserves seeded choice, offered order, calls and state', () => {
  const fixture = (enabled: boolean) => {
    let seed = 0x12345678;
    const next = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const state = { calls: 0, queue: ['already-queued'], candidates: ['a', 'b', 'c', 'd'] };
    const offered = [...state.candidates].sort(() => next() - 0.5);
    const audit = createPickerAuditRecorder('pool', null, null, {
      enabled, attemptId: 'fixture', now: NOW, write: () => {},
    });
    audit.captureCandidates(offered);
    state.calls++;
    const chosen = offered[Math.floor(next() * offered.length)];
    state.queue.push(chosen);
    audit.finish({ outcome: 'success', chosenId: chosen });
    return { state, offered, chosen, seed };
  };
  assert.deepEqual(fixture(false), fixture(true));
});

test('source wiring observes existing boundaries without adding model or search calls', async () => {
  const root = resolve(import.meta.dirname, '..');
  const [scope, agent, pool, scheduler] = await Promise.all([
    readFile(resolve(root, 'src/llm/internal/tools/picker/scope.ts'), 'utf8'),
    readFile(resolve(root, 'src/broadcast/dj-agent.ts'), 'utf8'),
    readFile(resolve(root, 'src/music/picker.ts'), 'utf8'),
    readFile(resolve(root, 'src/broadcast/scheduler.ts'), 'utf8'),
  ]);
  assert.match(scope, /const seen = scope\.seen \?\? new Map/);
  assert.match(agent, /seen: auditSeen/);
  assert.match(agent, /audit\.captureCandidates\(extras\.seen\.keys\(\)\)/);
  assert.match(agent, /audit\.finish\(\{\s*outcome: 'error', fallbackPath: 'pool'/);
  assert.match(agent, /const auditRunStartedAt = pickerAuditEnabled\(\) \? performance\.now\(\) : null;/);
  assert.match(agent, /classifyPickerFailure\(error, performance\.now\(\) - auditRunStartedAt\)/);
  assert.match(agent, /throw error;/);
  assert.match(agent, /breakerFailure\(queue\)/);
  assert.match(agent, /const pooled = await pickViaPool/);
  assert.ok(
    agent.indexOf('const selectedFromV2Joint = audit.captureV2Selection(song.id)')
      > agent.indexOf('if (albumHours > 0)'),
    'v2 attribution must use the final candidate after artist and album repicks',
  );
  assert.match(agent, /receipt => \{\s*acceptedReceipt = receipt;\s*if \(selectedFromV2Joint\) audit\.recordV2Enqueued\(receipt\.token\);\s*\}/);
  assert.match(agent, /const token = \(acceptedReceipt as QueueInsertionReceipt \| null\)\?\.token \?\? null;/);
  assert.match(pool, /onAuditCandidates\?\.\(candidates\.map\(\(c\) => c\?\.id\)\)/);
  assert.match(pool, /CANDIDATE_CAP = 18/);
  assert.match(scheduler, /TARGET_POOL = 40/);
  assert.match(scheduler, /audit\?\.captureCandidates\(pool\.map\(\(t: any\) => t\?\.id\)\)/);
  assert.doesNotMatch(agent, /logEvent\(['"]pick\.audit/);
});

test('fallback and collision outcomes remain distinct from independent attempt IDs', () => {
  const events: PickerAuditEvent[] = [];
  for (const [outcome, fallbackPath] of [['fallback', 'pool'], ['collision', undefined]] as const) {
    const audit = createPickerAuditRecorder('agent', null, null, {
      enabled: true, attemptId: 'shared-track-trace', now: NOW, write: event => events.push(event),
    });
    audit.captureCandidates(['fixture']);
    audit.finish({ outcome, ...(fallbackPath ? { fallbackPath } : {}) });
  }
  assert.deepEqual(events.map(event => [event.attempt_id, event.path, event.outcome]), [
    ['shared-track-trace', 'agent', 'fallback'],
    ['shared-track-trace', 'agent', 'collision'],
  ]);
});
