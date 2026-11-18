import assert from 'node:assert/strict';
import test from 'node:test';
import { NoObjectGeneratedError } from 'ai';
import {
  buildSemanticOneCallGenerationOptions,
  buildSemanticRecoveryOnlyGenerationOptions,
  decodeGeneratedSemanticResult,
  generateSemanticRecoveryOnly,
  generateSemanticOneCall,
} from '../src/music/semantic/one-call.js';
import { PROMPT_STATIC } from '../src/music/semantic/prompt-v2.js';
import {
  EXPECTED_SCHEMA_SHA256,
  FROZEN_MODEL,
  FROZEN_TEMPERATURE,
  SemanticTrackResultSchema,
  stableJson,
} from '../src/music/semantic/contract-v2.js';
import { validateSemanticContract } from '../src/music/semantic/canonical-contract.js';

const track = {
  id: 'track-1',
  title: 'Track',
  artist: 'Artist',
  album: 'Album',
  year: 2015,
  genres: ['Ambient'],
  evidence: '{"semantic_prompt_readiness":"PROMPT_BASIC"}',
};

const result = {
  id: track.id,
  e: 'S' as const,
  m: {
    Serene: ['N'] as ['N'], Warm: ['Y', 'M'] as ['Y', 'M'], Bright: ['N'] as ['N'],
    Playful: ['N'] as ['N'], Bittersweet: ['N'] as ['N'], Melancholic: ['N'] as ['N'],
    Dark: ['N'] as ['N'], Tense: ['N'] as ['N'], Wonder: ['N'] as ['N'],
  },
  b: ['N', 'N', 'N'] as ['N', 'N', 'N'],
};

test('one-call request identity is frozen and contains no recovery prose', () => {
  const options = buildSemanticOneCallGenerationOptions(PROMPT_STATIC, track, SemanticTrackResultSchema, {
    openrouter: { provider: { ignore: ['open-inference', 'deepinfra'], allow_fallbacks: true, require_parameters: true } },
  });
  assert.equal(options.instructions, PROMPT_STATIC);
  assert.equal(options.prompt, stableJson(track));
  assert.equal(options.temperature, FROZEN_TEMPERATURE);
  assert.equal(options.maxOutputTokens, 2048);
  assert.equal(options.maxRetries, 0);
  assert.ok(options.output);
  assert.equal(FROZEN_MODEL, 'deepseek/deepseek-v4-flash-0731');
  assert.equal(EXPECTED_SCHEMA_SHA256.length, 64);
  assert.equal(options.prompt.includes('schemaHint'), false);
  assert.equal(options.prompt.includes('Respond with a single JSON object only'), false);
});

test('materialized object uses one provider invocation', async () => {
  let calls = 0;
  const resultValue = await generateSemanticOneCall({
    model: {}, system: PROMPT_STATIC, track,
    generate: async () => { calls += 1; return { output: result }; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(resultValue, result);
});

test('same-call text recovery uses no second provider invocation', async () => {
  let calls = 0;
  const recovered = await generateSemanticOneCall({
    model: {}, system: PROMPT_STATIC, track,
    generate: async () => {
      calls += 1;
      const error: any = new Error('No output generated.');
      error.name = 'AI_NoOutputGeneratedError';
      return { get output(): never { throw error; }, text: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``, finishReason: 'stop' };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(recovered, result);
});

test('current SDK NoObjectGeneratedError recovers its same-call text', async () => {
  let calls = 0;
  const recovered = await generateSemanticOneCall({
    model: {}, system: PROMPT_STATIC, track,
    generate: async () => {
      calls += 1;
      const error = new NoObjectGeneratedError({
        message: 'No object generated: response did not match schema.',
        text: JSON.stringify(result),
        response: {} as any,
        usage: {} as any,
        finishReason: 'stop',
      });
      throw error;
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(recovered, result);
});

test('length and empty same-call responses are terminal', () => {
  let lengthError: unknown;
  try {
    decodeGeneratedSemanticResult({
      get output(): never { const error: any = new Error('No output generated.'); error.name = 'AI_NoOutputGeneratedError'; throw error; },
      text: '{', finishReason: 'length',
    });
  } catch (error) { lengthError = error; }
  assert.match(String(lengthError), /SEMANTIC_OUTPUT_TRUNCATED/);
  let emptyError: unknown;
  try {
    decodeGeneratedSemanticResult({
      get output(): never { const error: any = new Error('No output generated.'); error.name = 'AI_NoOutputGeneratedError'; throw error; },
      text: '', finishReason: 'stop',
    });
  } catch (error) { emptyError = error; }
  assert.match(String(emptyError), /SEMANTIC_NO_OUTPUT/);
});

test('transient retry counts each actual provider attempt', async () => {
  let calls = 0;
  let hooks = 0;
  const recovered = await generateSemanticOneCall({
    model: {}, system: PROMPT_STATIC, track,
    onProviderCall: () => { hooks += 1; return hooks; },
    generate: async () => {
      calls += 1;
      if (calls === 1) { const error: any = new Error('503'); error.statusCode = 503; throw error; }
      return { output: result };
    },
  });
  assert.equal(calls, 2);
  assert.equal(hooks, 2);
  assert.deepEqual(recovered, result);
});

test('recovery-only request matches the current recovery format', () => {
  const options = buildSemanticRecoveryOnlyGenerationOptions(PROMPT_STATIC, track, SemanticTrackResultSchema, {
    openrouter: { provider: { ignore: ['open-inference', 'deepinfra'], allow_fallbacks: true, require_parameters: true } },
  }, { provider: 'openrouter', model: FROZEN_MODEL, reasoning: false });
  assert.equal(options.instructions, PROMPT_STATIC);
  assert.match(options.prompt, /^\{"album":"Album"/);
  assert.match(options.prompt, /Respond with a single JSON object only — no prose, no markdown fences\./);
  assert.match(options.prompt, /MUST validate against this JSON Schema/);
  assert.equal(options.temperature, 0.2);
  assert.equal(options.maxOutputTokens, 2048);
  assert.equal(options.maxRetries, 0);
  assert.ok(options.providerOptions);
});

test('recovery-only parses thinking and markdown wrappers once', async () => {
  let calls = 0;
  const recovered = await generateSemanticRecoveryOnly({
    model: {}, system: PROMPT_STATIC, track,
    providerConfig: { provider: 'openrouter', model: FROZEN_MODEL, reasoning: false },
    generate: async () => { calls += 1; return { text: `<think>private</think>\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\``, finishReason: 'stop' }; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(recovered, result);
});

test('recovery-only invalid text and contract failure are terminal', async () => {
  let calls = 0;
  await assert.rejects(() => generateSemanticRecoveryOnly({
    model: {}, system: PROMPT_STATIC, track,
    generate: async () => { calls += 1; return { text: '{"bad":true}', finishReason: 'stop' }; },
  }), /SCHEMA_FAILURE|invalid_type/);
  assert.equal(calls, 1);
  const invalidContract = structuredClone(result);
  invalidContract.m.Bittersweet = ['Y', 'M'];
  invalidContract.b = ['Y', 'N', 'Y'];
  const verdict = validateSemanticContract(invalidContract);
  assert.equal(verdict.semanticValid, false);
  assert.equal(verdict.code, 'SEMANTIC_CONTRACT_BITTERSWEET_GATE');
});
