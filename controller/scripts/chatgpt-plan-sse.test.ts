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

test('rejects oversized and malformed streams without echoing their contents', async () => {
  await assert.rejects(readPlanCompletion(stream('data: secret\n\n'), undefined, 4), { code: 'stream_too_large' });
  await assert.rejects(readPlanCompletion(stream('data: secret\n\n')), (err: unknown) => err instanceof PlanStreamError && err.code === 'invalid_event' && !err.message.includes('secret'));
});

test('aborted streams cannot return a completion', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readPlanCompletion(stream('data: {"type":"response.completed","response":{}}\n\n'), controller.signal), { name: 'AbortError' });
});
