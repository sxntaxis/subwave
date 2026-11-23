import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText, isStepCount, tool } from 'ai';
import { z } from 'zod';
import { createPlanModel, planRequest } from '../src/llm/internal/provider/chatgpt-plan-model.js';
import type { PlanStreamError } from '../src/llm/internal/provider/chatgpt-plan-sse.js';
import { failureDiagnostics } from '../src/llm/internal/core/pure.js';

function completed(output: unknown[]) {
  const event = { type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 12, output_tokens: 8 } } };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}

test('SDK tool loop keeps tool results and encrypted reasoning on the next request', async () => {
  const requests: Record<string, unknown>[] = [];
  let executions = 0;
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer session-fixture');
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (requests.length === 1) return completed([
      { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'opaque-fixture', summary: [] },
      { type: 'function_call', namespace: 'subwave', name: 'search', call_id: 'call_fixture', arguments: '{"query":"night"}' },
    ]);
    return completed([{ type: 'function_call', namespace: 'subwave', name: 'done', call_id: 'done_fixture', arguments: '{"trackId":"fixture-101","reason":"matches"}' }]);
  };
  const model = createPlanModel('fixture-model', async () => 'session-fixture', fakeFetch);
  const result = await generateText({
    model,
    instructions: 'Select only a discovered track.',
    prompt: 'Choose a track.',
    tools: {
      search: tool({ inputSchema: z.object({ query: z.string() }), execute: async () => { executions++; return [{ id: 'fixture-101' }]; } }),
      done: tool({ inputSchema: z.object({ trackId: z.string(), reason: z.string() }) }),
    },
    toolChoice: 'required',
    stopWhen: isStepCount(2),
    prepareStep: ({ stepNumber }) => ({ activeTools: stepNumber === 0 ? ['search'] : ['done'], toolChoice: 'required' }),
    temperature: 0.5,
    maxOutputTokens: 50,
  });
  assert.equal(executions, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(result.steps[1]?.toolCalls[0]?.input, { trackId: 'fixture-101', reason: 'matches' });
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].stream, true);
  assert.equal(requests[0].temperature, undefined);
  assert.equal(requests[0].max_output_tokens, undefined);
  const history = requests[1].input as Record<string, unknown>[];
  assert.ok(history.some(item => item.type === 'reasoning' && item.encrypted_content === 'opaque-fixture'));
  assert.ok(history.some(item => item.type === 'function_call_output' && item.call_id === 'call_fixture' && String(item.output).includes('fixture-101')));
});

test('a failed stream never causes the SDK to execute a partial tool call', async () => {
  let executions = 0;
  const fakeFetch: typeof fetch = async () => new Response(
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"search","call_id":"x","arguments":"{}"}}\n\n' +
    'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
  await assert.rejects(generateText({
    model: createPlanModel('fixture', async () => 'session-fixture', fakeFetch),
    prompt: 'Search', maxRetries: 0,
    tools: { search: tool({ inputSchema: z.object({}), execute: async () => { executions++; return 'wrong'; } }) },
  }));
  assert.equal(executions, 0);
});

test('incomplete response diagnostics are bounded, contextual, and do not retry', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    return new Response(
      'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens","private":"secret"},"error":{"message":"private provider detail"}}}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  const model = createPlanModel('gpt-6-luna', async () => 'session-fixture', fakeFetch);
  const err = await model.doGenerate({
    prompt: [{
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolName: 'search',
        toolCallId: 'private-call-id',
        input: { credential: 'must-not-leak' },
      }],
    }],
  } as any).then(
    () => assert.fail('incomplete provider response must reject'),
    error => error as Error & { providerDiagnostic?: Record<string, unknown> },
  );
  const diagnostic = err.providerDiagnostic!;
  assert.equal(diagnostic.provider, 'chatgpt-plan');
  assert.equal(diagnostic.model, 'gpt-6-luna');
  assert.equal(diagnostic.classification, 'provider_response_incomplete');
  assert.equal(diagnostic.terminalEventKind, 'response.incomplete');
  assert.equal(diagnostic.incompleteReason, 'max_output_tokens');
  assert.equal(diagnostic.providerErrorCode, null);
  assert.equal(diagnostic.providerStatus, null);
  assert.equal(diagnostic.toolCallCount, 1);
  assert.equal(diagnostic.retryRecoveryAttempted, false);
  assert.equal(typeof diagnostic.elapsedMs, 'number');
  assert.equal(JSON.stringify(failureDiagnostics(err, false)).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(failureDiagnostics(err, false)).includes('private'), false);
  assert.equal(calls, 1, 'classification does not make another provider request');
});

test('unknown incomplete retries only the failed provider step, preserving prior tool evidence', async () => {
  const requests: Record<string, unknown>[] = [];
  let searches = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (requests.length === 1) return completed([
      { type: 'function_call', namespace: 'subwave', name: 'search', call_id: 'known', arguments: '{"query":"cars"}' },
    ]);
    if (requests.length === 2) return new Response(
      'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    return completed([
      { type: 'function_call', namespace: 'subwave', name: 'done', call_id: 'answer', arguments: '{"trackId":"car-song"}' },
    ]);
  };
  const result = await generateText({
    model: createPlanModel('fixture-model', async () => 'token', fakeFetch),
    prompt: 'Select a matching track.',
    tools: {
      search: tool({ inputSchema: z.object({ query: z.string() }), execute: async () => {
        searches++;
        return [{ id: 'car-song' }];
      } }),
      done: tool({ inputSchema: z.object({ trackId: z.string() }) }),
    },
    toolChoice: 'required',
    stopWhen: isStepCount(2),
    prepareStep: ({ stepNumber }) => ({ activeTools: stepNumber === 0 ? ['search'] : ['done'], toolChoice: 'required' }),
  });
  assert.equal(searches, 1, 'the already completed discovery tool is not replayed');
  assert.equal(requests.length, 3, 'only the failed model step was retried');
  assert.deepEqual(requests[1], requests[2], 'the failed step is retried with the same grounded prompt');
  assert.deepEqual(result.steps[1]?.toolCalls[0]?.input, { trackId: 'car-song' });
});

test('unknown incomplete retries at most once and records that a retry happened', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    return new Response('data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n');
  };
  const model = createPlanModel('fixture-model', async () => 'token', fakeFetch);
  const err = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] } as any).then(
    () => assert.fail('incomplete response must not be accepted'),
    error => error as PlanStreamError,
  );
  assert.equal(calls, 2);
  assert.equal(err.providerDiagnostic?.retryRecoveryAttempted, true);
  assert.equal(err.providerDiagnostic?.terminalEventKind, 'response.incomplete');
});

test('subscription quota prevents immediate repeated requests', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    return new Response('data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n');
  };
  const model = createPlanModel('fixture', async () => 'session-fixture', fakeFetch);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] }));
  }
  assert.equal(calls, 1);
});

test('permission refusal does not repeatedly contact the plan endpoint', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    return Response.json({ error: { code: 'subscription_sharing_user_not_eligible' } }, { status: 403 });
  };
  const model = createPlanModel('fixture', async () => 'session-fixture', fakeFetch);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] }), { code: 'subscription_sharing_user_not_eligible', statusCode: 403 });
  }
  assert.equal(calls, 1);
});

test('a persisted subscription limit blocks future requests until operator retry', async () => {
  let blocked = false;
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    return new Response('data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n');
  };
  const model = createPlanModel('fixture', async () => {
    if (blocked) throw new Error('session blocked');
    return 'session-fixture';
  }, fakeFetch, undefined, async (_token, reason) => {
    assert.equal(reason, 'subscription_sharing_usage_limit_exceeded');
    blocked = true;
  });
  const options = { prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'test' }] }] };
  await assert.rejects(model.doGenerate(options));
  await assert.rejects(model.doGenerate(options), /session blocked/);
  assert.equal(calls, 1);
  blocked = false;
  await assert.rejects(model.doGenerate(options));
  assert.equal(calls, 2, 'explicit retry reopens the request');
});

test('specific forced tool is isolated and provider tools are refused', () => {
  const body = planRequest('fixture', {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
    tools: [
      { type: 'function', name: 'one', inputSchema: { type: 'object' } },
      { type: 'function', name: 'two', inputSchema: { type: 'object' } },
    ],
    toolChoice: { type: 'tool', toolName: 'two' },
  });
  assert.equal(body.tool_choice, 'required');
  const namespace = (body.tools as Array<{ tools: Array<{ name: string }> }>)[0];
  assert.deepEqual(namespace.tools.map(t => t.name), ['two']);
});
