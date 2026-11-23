import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

const stateDir = mkdtempSync(join(tmpdir(), 'request-budget-integration-'));
process.env.STATE_DIR = stateDir;

const [{ requestAgent }, { pickerScope }, { withAgentRunnerForTest },
  { djAgent }, { withProviderLegsForTest }] = await Promise.all([
  import('../src/broadcast/dj-agent/agents.js'),
  import('../src/llm/internal/tools/picker/scope.js'),
  import('../src/llm/internal/agent-factory.js'),
  import('../src/llm/internal/strategy/agent.js'),
  import('../src/llm/internal/provider/legs.js'),
]);

after(async () => {
  const { rmSync } = await import('node:fs');
  rmSync(stateDir, { recursive: true, force: true });
});

test('requestAgent forwards its per-run timeout override through the test runner', async () => {
  let observed: any;
  const fake = (async (options: any) => {
    observed = options;
    return { object: { kind: 'chat', id: null }, steps: 0, toolCalls: [] };
  }) as typeof djAgent;

  await withAgentRunnerForTest(fake, () => requestAgent.run({
    scope: pickerScope({}),
    messages: [],
    requestTimeoutMs: 12_345,
  }));

  assert.equal(observed.kind, 'djAgentRequest');
  assert.equal(observed.timeoutMs, 12_345);
});

test('no-tools structured request output is bounded by the request deadline', async () => {
  const model = new MockLanguageModelV3({ doGenerate: () => new Promise(() => {}) });
  const leg = {
    cfg: { provider: 'ollama', model: 'fixture-model', reasoning: false },
    model,
    noThinkModel: model,
    label: 'ollama:fixture-model',
  };

  await assert.rejects(withProviderLegsForTest({ primary: leg, fallback: null }, () =>
    djAgent({
      kind: 'djAgentRequest',
      system: 'fixture',
      messages: [{ role: 'user', content: 'fixture' }],
      schema: z.object({ kind: z.string() }),
      timeoutMs: 40,
    })), (error: any) => error.name === 'AgentDeadlineError');
  assert.equal(model.doGenerateCalls.length, 1);
});

test('request failover legs share one deadline instead of resetting the timeout', async () => {
  const primaryModel = new MockLanguageModelV3({
    doGenerate: async () => {
      await new Promise(resolve => setTimeout(resolve, 140));
      throw Object.assign(new Error('fixture unauthorized'), { statusCode: 401 });
    },
  });
  const fallbackModel = new MockLanguageModelV3({ doGenerate: () => new Promise(() => {}) });
  const primary = {
    cfg: { provider: 'ollama', model: 'fixture-primary', reasoning: false },
    model: primaryModel,
    noThinkModel: primaryModel,
    label: 'ollama:fixture-primary',
  };
  const fallback = {
    cfg: { provider: 'ollama', model: 'fixture-fallback', reasoning: false },
    model: fallbackModel,
    noThinkModel: fallbackModel,
    label: 'ollama:fixture-fallback',
  };
  const startedAt = Date.now();

  await assert.rejects(withProviderLegsForTest({ primary, fallback }, () =>
    djAgent({
      kind: 'djAgentRequest',
      system: 'fixture',
      messages: [{ role: 'user', content: 'fixture' }],
      schema: z.object({ kind: z.string() }),
      timeoutMs: 250,
    })), (error: any) => error.name === 'AgentDeadlineError');

  assert.equal(primaryModel.doGenerateCalls.length, 1);
  assert.equal(fallbackModel.doGenerateCalls.length, 1);
  assert.ok(Date.now() - startedAt < 340, 'backup leg must use only the remaining request time');
});
