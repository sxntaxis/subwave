import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanStreamError, readPlanCompletion } from '../src/llm/internal/provider/chatgpt-plan-sse.js';

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

test('requires terminal completion, even after partial text', async () => {
  await assert.rejects(readPlanCompletion(stream('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')), { code: 'incomplete_stream' });
  const result = await readPlanCompletion(stream('data: {"type":"response.comp', 'leted","response":{"status":"completed"}}\r\n\r\n'));
  assert.equal(result.status, 'completed');
});

test('a failure after output is never a successful response', async () => {
  const chunks = stream(
    'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n',
  );
  await assert.rejects(readPlanCompletion(chunks), { code: 'subscription_sharing_usage_limit_exceeded' });
});

test('classifies provider incomplete reasons without retaining event payloads', async () => {
  const event = {
    type: 'response.incomplete',
    response: {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens', private: 'must-not-leak' },
      output: [{ text: 'private response text' }],
      error: { message: 'private provider message', code: 'provider_limited' },
    },
  };
  await assert.rejects(readPlanCompletion(stream(`data: ${JSON.stringify(event)}\n\n`)), (err: unknown) => {
    assert.ok(err instanceof PlanStreamError);
    assert.equal(err.code, 'provider_limited');
    assert.equal(err.terminalEventKind, 'response.incomplete');
    assert.equal(err.incompleteReason, 'max_output_tokens');
    assert.equal(err.providerErrorCode, 'provider_limited');
    const serialized = JSON.stringify(err);
    assert.ok(serialized.includes('"terminalEventKind":"response.incomplete"'));
    assert.equal(serialized.includes('must-not-leak'), false);
    assert.equal(serialized.includes('private response text'), false);
    assert.equal(serialized.includes('private provider message'), false);
    assert.equal(err.message.includes('private'), false);
    return true;
  });
});

test('classifies missing or unrecognized incomplete reasons as unknown', async () => {
  for (const response of [
    { status: 'incomplete' },
    { incomplete_details: { reason: 'unrecognized_reason' } },
  ]) {
    await assert.rejects(readPlanCompletion(stream(`data: ${JSON.stringify({ type: 'response.incomplete', response })}\n\n`)), (err: unknown) => {
      assert.ok(err instanceof PlanStreamError);
      assert.equal(err.code, 'response.incomplete');
      assert.equal(err.terminalEventKind, 'response.incomplete');
      assert.equal(err.incompleteReason, 'unknown');
      assert.equal(err.providerErrorCode, null);
      return true;
    });
  }
});

test('classifies safe provider error codes and status, but not raw error text', async () => {
  const event = {
    type: 'response.failed',
    status: 503,
    response: { error: { code: 'upstream_busy', message: 'private token text', status: 502 } },
  };
  await assert.rejects(readPlanCompletion(stream(`data: ${JSON.stringify(event)}\n\n`)), (err: unknown) => {
    assert.ok(err instanceof PlanStreamError);
    assert.equal(err.terminalEventKind, 'response.failed');
    assert.equal(err.providerErrorCode, 'upstream_busy');
    assert.equal(err.statusCode, 502);
    assert.equal(err.message.includes('private'), false);
    return true;
  });
});

test('classifies an abruptly ended stream as missing a provider terminal event', async () => {
  await assert.rejects(readPlanCompletion(stream('data: {"type":"response.output_text.delta","delta":"private"}\n\n')), (err: unknown) => {
    assert.ok(err instanceof PlanStreamError);
    assert.equal(err.code, 'incomplete_stream');
    assert.equal(err.terminalEventKind, 'stream_ended_without_terminal');
    assert.equal(err.incompleteReason, 'unknown');
    assert.equal(err.message.includes('private'), false);
    return true;
  });
});

test('rejects oversized and malformed streams without echoing their contents', async () => {
  await assert.rejects(readPlanCompletion(stream('data: secret\n\n'), undefined, 4), { code: 'stream_too_large' });
  await assert.rejects(readPlanCompletion(stream('data: secret\n\n')), (err: unknown) => err instanceof PlanStreamError && err.code === 'invalid_event' && !err.message.includes('secret'));
});

test('aborted streams cannot return a completion', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readPlanCompletion(stream('data: {"type":"response.completed","response":{}}\n\n'), controller.signal), { name: 'AbortError' });
});
