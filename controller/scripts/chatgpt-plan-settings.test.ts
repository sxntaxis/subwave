import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-plan-settings-'));
process.env.STATE_DIR = root;
const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { resolveEmbeddingCfg } = await import('../src/llm/internal/provider/embedding.js');
const { isQuotaOrAuthError, isTransient, isPlanFailure } = await import('../src/llm/internal/core/pure.js');
const { PlanStreamError } = await import('../src/llm/internal/provider/chatgpt-plan-sse.js');
const { withFailover } = await import('../src/llm/internal/core/failover.js');

test('plan settings cold-load and preserve inherited embedding configuration', async () => {
  await settings.load();
  await settings.update({ llm: { provider: 'openrouter', model: 'fixture-chat', apiKey: 'fixture-openrouter-key' } });
  const before = resolveEmbeddingCfg();
  assert.equal(before.provider, 'openrouter');
  await settings.update({ llm: { provider: 'chatgpt-plan', model: 'gpt-6-luna' } });
  assert.equal(settings.get().embedding.provider, 'openrouter');
  const after = resolveEmbeddingCfg();
  assert.equal(after.provider, before.provider);
  assert.equal(after.model, before.model);
  assert.equal(after.apiKey, before.apiKey);
  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.provider, 'chatgpt-plan');
  assert.equal(settings.get().embedding.provider, 'openrouter');
  assert.equal(resolveEmbeddingCfg().apiKey, before.apiKey);
  await assert.rejects(settings.update({ embedding: { provider: 'chatgpt-plan' } }), /does not provide embeddings/);
});

test('plan quota is failover-worthy and not transient', () => {
  const error = new PlanStreamError('subscription_sharing_usage_limit_exceeded');
  assert.equal(isPlanFailure(error), true);
  assert.equal(isQuotaOrAuthError(error), true);
  assert.equal(isTransient(error), false);
});

test('plan failure cannot silently fall back to a metered provider', async () => {
  await settings.update({ llm: { fallback: { enabled: true, provider: 'openrouter', model: 'fixture-paid' } } });
  let attempts = 0;
  await assert.rejects(withFailover('plan.test', () => ({}), async () => {
    attempts++;
    throw new PlanStreamError('subscription_sharing_usage_limit_exceeded');
  }));
  assert.equal(attempts, 1);
  await settings.update({ llm: { fallback: { enabled: true, provider: 'ollama', model: '' } } });
  attempts = 0;
  await assert.rejects(withFailover('plan.test', () => ({}), async () => {
    attempts++;
    throw new PlanStreamError('subscription_sharing_usage_limit_exceeded');
  }));
  assert.equal(attempts, 1, 'the default cloud Ollama model is not a local fallback');
  await settings.update({ llm: { fallback: { enabled: true, provider: 'ollama', model: 'local-fixture' } } });
  const result = await withFailover('plan.test', () => ({}), async leg => {
    if (leg.cfg.provider === 'chatgpt-plan') throw new PlanStreamError('subscription_sharing_usage_limit_exceeded');
    return { value: 'local', via: 'fixture' };
  });
  assert.equal(result, 'local');
});

test.after(() => { rmSync(root, { recursive: true, force: true }); });
