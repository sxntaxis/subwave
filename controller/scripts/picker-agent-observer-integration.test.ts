import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockLanguageModelV3 } from 'ai/test';

const stateDir = mkdtempSync(join(tmpdir(), 'picker-agent-observer-'));
process.env.STATE_DIR = stateDir;

const settings = await import('../src/settings.js');
await settings.load();
const { pickerAgent } = await import('../src/broadcast/dj-agent/agents.js');
const { pickerScope } = await import('../src/llm/internal/tools/picker/scope.js');
const { djAgent } = await import('../src/llm/internal/strategy/agent.js');
const { withProviderLegsForTest } = await import('../src/llm/internal/provider/legs.js');
const {
  classifyPickerFailure, createPickerAuditRecorder,
} = await import('../src/observability/picker-audit.js');
type PickerAgentDiagnosticsObserver =
  import('../src/observability/picker-audit.js').PickerAgentDiagnosticsObserver;

const candidates = [
  { id: 'fixture-candidate-1', title: 'Fixture One', artist: 'Fixture Artist', duration: 180 },
  { id: 'fixture-candidate-2', title: 'Fixture Two', artist: 'Fixture Artist', duration: 180 },
];

function toolCall(toolName: string, input: unknown, toolCallId: string) {
  return {
    content: [{
      type: 'tool-call' as const,
      toolName,
      input: JSON.stringify(input),
      toolCallId,
    }],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
    warnings: [],
    response: { id: `fixture-response-${toolCallId}`, modelId: 'fixture-model' },
  };
}

function fixtureLeg(model: InstanceType<typeof MockLanguageModelV3>) {
  return {
    cfg: { provider: 'ollama', model: 'fixture-model', reasoning: false },
    model,
    noThinkModel: model,
    label: 'ollama:fixture-model',
  };
}

function audit(enabled: boolean, written: unknown[]) {
  return createPickerAuditRecorder('agent', null, null, {
    enabled,
    attemptId: enabled ? 'fixture-attempt' : null,
    write: event => written.push(event),
  });
}

function tapObserver(observer: PickerAgentDiagnosticsObserver) {
  const counts = {
    generationStarted: 0,
    generationCompleted: 0,
    toolStarted: 0,
    toolCompleted: 0,
    toolFailed: 0,
    retry: [] as string[],
    failover: [] as string[],
  };
  return {
    counts,
    observer: {
      failurePhaseObserved: (phase: Parameters<typeof observer.failurePhaseObserved>[0]) =>
        observer.failurePhaseObserved(phase),
      providerGenerationStarted() {
        counts.generationStarted++;
        observer.providerGenerationStarted();
      },
      providerGenerationCompleted() {
        counts.generationCompleted++;
        observer.providerGenerationCompleted();
      },
      toolStarted() {
        counts.toolStarted++;
        observer.toolStarted();
      },
      toolFinished(success: boolean, comparator?: boolean) {
        if (success) counts.toolCompleted++;
        else counts.toolFailed++;
        observer.toolFinished(success, comparator);
      },
      retryNotAttempted() { counts.retry.push('not_attempted'); observer.retryNotAttempted(); },
      retryAttempted() { counts.retry.push('attempted'); observer.retryAttempted(); },
      retrySucceeded() { counts.retry.push('succeeded'); observer.retrySucceeded(); },
      retryExhausted() { counts.retry.push('exhausted'); observer.retryExhausted(); },
      failoverNotAttempted() { counts.failover.push('not_attempted'); observer.failoverNotAttempted(); },
      failoverAttempted() { counts.failover.push('attempted'); observer.failoverAttempted(); },
    },
  };
}

async function runPicker(model: InstanceType<typeof MockLanguageModelV3>, diagnostics?: object) {
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    return await withProviderLegsForTest({ primary: fixtureLeg(model), fallback: null }, () =>
      pickerAgent.run({
        messages: [{ role: 'user', content: 'fixture pick request' }],
        scope: pickerScope({ playlistTracks: candidates }),
        ...(diagnostics ? { diagnostics } : {}),
      } as any));
  } finally {
    Math.random = originalRandom;
  }
}

test('the real picker Agent strategy is equivalent with its observer absent or enabled', async () => {
  const run = async (enabled: boolean) => {
    let generation = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        generation++;
        return generation === 1
          ? toolCall('showPlaylistTracks', {}, 'discover')
          : toolCall('done', {
            id: candidates[0].id, reason: 'fixture reason', say: null, transition: null,
          }, 'commit');
      },
    });
    const writes: unknown[] = [];
    const recorder = audit(enabled, writes);
    const tapped = enabled ? tapObserver(recorder.agentDiagnosticsObserver()!) : undefined;
    const result = await runPicker(model, tapped?.observer);
    recorder.finish({
      outcome: 'success',
      chosenId: result.object.id,
      toolCalls: result.toolCalls.length,
    });
    return {
      result,
      writes,
      observerCounts: tapped?.counts,
      providerCalls: model.doGenerateCalls.length,
      promptAndTools: model.doGenerateCalls.map(call => ({
        prompt: call.prompt,
        tools: call.tools,
        toolChoice: call.toolChoice,
      })),
    };
  };

  const off = await run(false);
  const on = await run(true);
  assert.equal(off.result.object.id, candidates[0].id);
  assert.equal(on.result.object.id, candidates[0].id);
  assert.equal(off.result.extras.seen.has(candidates[0].id), true);
  assert.equal(on.result.extras.seen.has(candidates[0].id), true);
  assert.deepEqual(on.result.object, off.result.object);
  assert.deepEqual(on.result.toolCalls, off.result.toolCalls);
  assert.equal(off.providerCalls, 2);
  assert.equal(on.providerCalls, 2);
  assert.deepEqual(on.promptAndTools, off.promptAndTools);
  assert.equal(off.observerCounts, undefined);
  assert.deepEqual(on.observerCounts, {
    generationStarted: 2,
    generationCompleted: 2,
    toolStarted: 1,
    toolCompleted: 1,
    toolFailed: 0,
    retry: [],
    failover: [],
  });
  assert.equal(off.writes.length, 0);
  assert.equal(on.writes.length, 1);
});

test('provider failure identity and sanitized phase stay unchanged with the observer enabled', async () => {
  const failure = new Error('private provider detail must not persist');
  const outcomes: Array<{ thrown: unknown; events: unknown[]; counts?: ReturnType<typeof tapObserver>['counts'] }> = [];

  for (const enabled of [false, true]) {
    const model = new MockLanguageModelV3({
      doGenerate: async () => { throw failure; },
    });
    const events: unknown[] = [];
    const recorder = audit(enabled, events);
    const tapped = enabled ? tapObserver(recorder.agentDiagnosticsObserver()!) : undefined;
    let thrown: unknown;
    try {
      await runPicker(model, tapped?.observer);
    } catch (error) {
      thrown = error;
      recorder.finish({ outcome: 'error', failure: classifyPickerFailure(error) });
    }
    outcomes.push({ thrown, events, counts: tapped?.counts });
  }

  assert.equal(outcomes[0].thrown, failure);
  assert.equal(outcomes[1].thrown, failure);
  assert.equal(outcomes[0].events.length, 0);
  assert.equal(outcomes[1].events.length, 1);
  const event = outcomes[1].events[0] as Record<string, unknown>;
  assert.equal(event.failure_phase, 'provider_generation');
  assert.equal(event.failure_category, 'other');
  assert.equal(event.failure_retry_status, 'unknown');
  assert.equal(event.failure_transient_retry_status, 'not_attempted');
  assert.equal(event.failure_tool_started_count, 0);
  assert.equal(event.failure_tool_completed_count, 0);
  assert.equal(event.failure_tool_failed_count, 0);
  assert.equal('failure_deadline_exhausted' in event, false);
  assert.equal('failure_http_status' in event, false);
  assert.equal(JSON.stringify(event).includes(failure.message), false);
  assert.deepEqual(outcomes[1].counts?.retry, ['not_attempted']);
  assert.deepEqual(outcomes[1].counts?.failover, ['not_attempted']);
});

test('throwing observer getters cannot change a successful Agent result', async () => {
  const methods = [
    'failurePhaseObserved', 'providerGenerationStarted', 'providerGenerationCompleted',
    'toolStarted', 'toolFinished', 'retryNotAttempted', 'retryAttempted', 'retrySucceeded',
    'retryExhausted', 'failoverNotAttempted', 'failoverAttempted',
  ];
  const diagnostics = Object.defineProperties({}, Object.fromEntries(methods.map(name => [
    name, { get() { throw new Error(`observer getter ${name}`); } },
  ])));
  let generation = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      generation++;
      return generation === 1
        ? toolCall('showPlaylistTracks', {}, 'discover-throwing-observer')
        : toolCall('done', {
          id: candidates[0].id, reason: 'fixture reason', say: null, transition: null,
        }, 'commit-throwing-observer');
    },
  });
  const result = await runPicker(model, diagnostics);
  assert.equal(result.object.id, candidates[0].id);
  assert.equal(model.doGenerateCalls.length, 2);
});

test('throwing observer getters cannot replace the provider error identity', async () => {
  const failure = new Error('identity fixture');
  const diagnostics = Object.defineProperty({}, 'providerGenerationStarted', {
    get() { throw new Error('observer getter failure'); },
  });
  const model = new MockLanguageModelV3({
    doGenerate: async () => { throw failure; },
  });
  let thrown: unknown;
  try {
    await runPicker(model, diagnostics);
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, failure);
  assert.equal(model.doGenerateCalls.length, 1);
});

test('failover observer reports only a backup leg that actually starts', async () => {
  const { withFailover } = await import('../src/llm/internal/core/failover.js');
  const primary = fixtureLeg(new MockLanguageModelV3());
  const fallback = fixtureLeg(new MockLanguageModelV3());
  const firstFailure = Object.assign(new Error('fixture connection refused'), { code: 'ECONNREFUSED' });
  const seen: string[] = [];
  let attempts = 0;
  const result = await withProviderLegsForTest({ primary, fallback }, () => withFailover(
    'picker.observer.fixture',
    () => ({}),
    async leg => {
      attempts++;
      if (leg === primary) throw firstFailure;
      return { value: 'backup-result', via: 'fixture' };
    },
    undefined,
    {
      failoverNotAttempted: () => seen.push('not_attempted'),
      failoverAttempted: () => seen.push('attempted'),
    },
  ));
  assert.equal(result, 'backup-result');
  assert.equal(attempts, 2);
  assert.deepEqual(seen, ['attempted']);

  let backupStarted = false;
  const throwingObserver = Object.defineProperty({}, 'failoverAttempted', {
    get() { throw new Error('observer getter failure'); },
  });
  const recovered = await withProviderLegsForTest({ primary, fallback }, () => withFailover(
    'picker.observer.getter-fixture',
    () => ({}),
    async leg => {
      if (leg === primary) throw firstFailure;
      backupStarted = true;
      return { value: 'recovered', via: 'fixture' };
    },
    undefined,
    throwingObserver as any,
  ));
  assert.equal(recovered, 'recovered');
  assert.equal(backupStarted, true);
});

test('AI SDK completed and errored tool callbacks are counts, not usable-pick claims', async () => {
  const { tool } = await import('ai');
  const { z } = await import('zod');
  const cases = [
    { label: 'result', execute: async () => ({ private: 'tool payload' }), completed: 1, failed: 0 },
    { label: 'error', execute: async () => { throw new Error('private tool detail'); }, completed: 0, failed: 1 },
  ] as const;

  for (const fixture of cases) {
    const providerFailure = new Error(`provider failure after tool ${fixture.label}`);
    let generation = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        generation++;
        if (generation === 1) return toolCall('fixtureTool', {}, `tool-${fixture.label}`);
        throw providerFailure;
      },
    });
    const events: unknown[] = [];
    const recorder = audit(true, events);
    const tapped = tapObserver(recorder.agentDiagnosticsObserver()!);
    let thrown: unknown;
    try {
      await withProviderLegsForTest({ primary: fixtureLeg(model), fallback: null }, () => djAgent({
        kind: 'djAgentPick',
        system: 'fixture system',
        messages: [{ role: 'user', content: 'fixture' }],
        tools: {
          fixtureTool: tool({
            inputSchema: z.object({}),
            execute: fixture.execute,
          }),
        },
        schema: z.object({ id: z.string() }),
        timeoutMs: 5_000,
        diagnostics: tapped.observer,
      }));
    } catch (error) {
      thrown = error;
      recorder.finish({ outcome: 'error', failure: classifyPickerFailure(error) });
    }

    assert.equal(thrown, providerFailure);
    assert.equal(model.doGenerateCalls.length, 2);
    assert.deepEqual(tapped.counts, {
      generationStarted: 2,
      generationCompleted: 1,
      toolStarted: 1,
      toolCompleted: fixture.completed,
      toolFailed: fixture.failed,
      retry: ['not_attempted'],
      failover: ['not_attempted'],
    });
    const event = events[0] as Record<string, unknown>;
    assert.equal(event.failure_phase, 'provider_generation');
    assert.equal(event.failure_tool_started_count, 1);
    assert.equal(event.failure_tool_completed_count, fixture.completed);
    assert.equal(event.failure_tool_failed_count, fixture.failed);
    assert.equal('usable_completed_result' in event, false);
    assert.equal('tool_payload' in event, false);
    assert.equal(JSON.stringify(event).includes('private tool payload'), false);
    assert.equal(JSON.stringify(event).includes('private tool detail'), false);
  }
});

test('real runTrackEvent preserves Pool enqueue and breaker behavior with private audit off or on', async () => {
  const { runTrackEvent } = await import('../src/broadcast/dj-agent.js');
  const { withPickerAuditForTest } = await import('../src/observability/picker-audit.js');
  const session = await import('../src/broadcast/session.js');
  const picker = await import('../src/music/picker.js');
  const library = await import('../src/music/library.js');
  const breaker = await import('../src/broadcast/dj-agent/breaker.js');
  const config = settings.get();
  const previousPickerAgent = config.llm.pickerAgent;
  const previousPoolFlag = process.env.PICKER_VNEXT_POOL;
  const previousAgentFlag = process.env.PICKER_VNEXT_AGENT;
  const current = {
    track: { id: 'fixture-current', title: 'Current Track', artist: 'Current Artist' },
    startedAt: new Date().toISOString(),
  };
  let poolCalls = 0;
  let enqueued = 0;
  const logs: string[] = [];
  const queue = {
    current, upcoming: [], history: [],
    recentlyPlayed: () => ({ ids: new Set<string>(), keys: new Set<string>() }),
    queuedIds: () => new Set<string>(),
    recentArtistsSince: () => new Set<string>(),
    recentAlbumKeys: () => new Set<string>(),
    recentlyPlayedByCount: () => ({ ids: new Set<string>(), keys: new Set<string>() }),
    recentTransitionChoices: () => [],
    getRecentOpeners: () => [],
    getRecentTracks: () => [],
    getDjRecap: () => '',
    getLastLinkText: () => null,
    log: (kind: string, message: string) => { logs.push(`${kind}:${message}`); },
    pushAiPick: async () => { enqueued++; return 1; },
  };
  const candidate = {
    id: 'fixture-pool-candidate', title: 'Pool Track', artist: 'Pool Artist', duration: 180,
  };
  const poolFixture = {
    build: async () => ({ candidates: [candidate], sources: {}, strictInfo: null, playlistInfo: null }),
    pick: async () => { poolCalls++; return { id: candidate.id, reason: 'fixture fallback' }; },
  };
  const failure = new Error('private route provider failure');
  const events: Array<Record<string, unknown>> = [];
  try {
    await settings.update({ llm: { pickerAgent: true } });
    assert.equal(settings.get().llm.pickerAgent, true);
    assert.equal(breaker.breakerOpen(), false);
    session.start({ dominantMood: null, activeShow: null } as any);
    process.env.PICKER_VNEXT_POOL = '0';
    process.env.PICKER_VNEXT_AGENT = '0';
    for (const enabled of [false, true]) {
      const model = new MockLanguageModelV3({
        doGenerate: async () => { throw failure; },
      });
      await withPickerAuditForTest({
        enabled,
        write: event => { if (enabled) events.push(event as Record<string, unknown>); },
      }, () => withProviderLegsForTest(
        { primary: fixtureLeg(model), fallback: null },
        () => picker.withPoolPickerFixtureForTest(poolFixture as any, () =>
          runTrackEvent(queue as any, { dominantMood: null, activeShow: null }, {
            wantLink: false,
            showAt: new Date(),
            target: { kind: 'current', item: current } as any,
          })),
      ));
      assert.equal(model.doGenerateCalls.length, 1, logs.join('\n'));
    }
    assert.equal(poolCalls, 2);
    assert.equal(enqueued, 2);
    assert.equal(breaker.breakerOpen(), false);
    const agentEvent = events.find(event => event.path === 'agent');
    const poolEvent = events.find(event => event.path === 'pool');
    assert.equal(events.length, 2);
    assert.equal(agentEvent?.outcome, 'error');
    assert.equal(agentEvent?.fallback_path, 'pool');
    assert.equal(agentEvent?.fallback_reason, 'agent_run_failed');
    assert.equal(agentEvent?.failure_phase, 'provider_generation');
    assert.equal(agentEvent?.failure_tool_completed_count, 0);
    assert.equal(JSON.stringify(agentEvent).includes(failure.message), false);
    assert.equal(poolEvent?.outcome, 'success');
  } finally {
    await settings.update({ llm: { pickerAgent: previousPickerAgent } });
    if (previousPoolFlag === undefined) delete process.env.PICKER_VNEXT_POOL;
    else process.env.PICKER_VNEXT_POOL = previousPoolFlag;
    if (previousAgentFlag === undefined) delete process.env.PICKER_VNEXT_AGENT;
    else process.env.PICKER_VNEXT_AGENT = previousAgentFlag;
    library.shutdown();
  }
});

test.after(() => {
  rmSync(stateDir, { recursive: true, force: true });
});
