import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { tool } from 'ai';

const root = mkdtempSync(join(tmpdir(), 'plan-primitives-'));
const credentials = join(root, 'credentials');
mkdirSync(credentials, { mode: 0o700 });
writeFileSync(join(credentials, 'session.json'), JSON.stringify({
  version: 1, clientId: 'oaiapp_fixture', subject: 'fixture-subject',
  credentials: { accessToken: 'fixture-token', refreshToken: 'fixture-refresh', idToken: 'fixture-id', expiresAt: Date.now() + 3_600_000, scopes: ['chatgpt.tokens.use.direct'] },
}), { mode: 0o600 });
process.env.STATE_DIR = join(root, 'state');
mkdirSync(process.env.STATE_DIR, { mode: 0o700 });
process.env.SUBWAVE_CHATGPT_PLAN_DIR = credentials;
const requests: Record<string, unknown>[] = [];
const replies: unknown[][] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
  requests.push(JSON.parse(String(init?.body)));
  const output = replies.shift();
  if (!output) throw new Error('No fixture response');
  return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 5, output_tokens: 4 } } })}\n\n`);
};
const settings = await import('../src/settings.js');
const { djText, djObject, djAgent } = await import('../src/llm/sdk.js');
await settings.load();
await settings.update({ llm: { provider: 'chatgpt-plan', model: 'fixture-model', fallback: { enabled: false } } });
const call = (name: string, args: unknown, id = 'call-1') => ({ type: 'function_call', namespace: 'subwave', name, call_id: id, arguments: JSON.stringify(args) });

test('djText and djObject complete through the registered plan leg', async () => {
  replies.push([{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }]);
  assert.equal(await djText({ prompt: 'Say hello' }), 'hello');
  replies.push([call('emit', { trackId: 'fixture-101', reason: 'match' })]);
  const result = await djObject({ prompt: 'Choose', schema: z.object({ trackId: z.string(), reason: z.string() }) });
  assert.deepEqual(result, { trackId: 'fixture-101', reason: 'match' });
});

test('djAgent performs discovery, sends the result, then returns done', async () => {
  let executed = 0;
  replies.push([call('search', { query: 'night' })]);
  replies.push([call('done', { trackId: 'fixture-101', reason: 'match' }, 'call-2')]);
  const result = await djAgent({
    system: 'Select an ID returned by search.',
    messages: [{ role: 'user', content: 'Choose a track' }],
    tools: { search: tool({ inputSchema: z.object({ query: z.string() }), execute: async () => { executed++; return [{ id: 'fixture-101' }]; } }) },
    schema: z.object({ trackId: z.string(), reason: z.string() }),
    timeoutMs: 10_000,
  });
  assert.equal(executed, 1);
  assert.deepEqual(result.object, { trackId: 'fixture-101', reason: 'match' });
  const last = requests.at(-1)!;
  assert.ok((last.input as Record<string, unknown>[]).some(i => i.type === 'function_call_output' && String(i.output).includes('fixture-101')));
});

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
});
