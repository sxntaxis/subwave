import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  CONTRACT_VERSION,
  DECODER_VERSION,
  EXPECTED_CONTRACT_SHA256,
  EXPECTED_PROMPT_STATIC_SHA256,
  EXPECTED_RENDERER_SHA256,
  EXPECTED_SCHEMA_SHA256,
  FROZEN_MODEL,
  FROZEN_REASONING,
  FROZEN_TEMPERATURE,
  PROTOCOL_VERSION,
  RENDERER_VERSION,
  SCHEMA_VERSION,
  SEMANTIC_EXPERIMENT_VERSION,
  SEMANTIC_MOODS,
  SemanticRequestSchema,
  semanticInputSha256,
  semanticRunFingerprint,
  validateFrozenRequest,
} from '../src/music/semantic/contract.js';
import { PROMPT_STATIC } from '../src/music/semantic/prompt.js';
import { buildSemanticGenerationOptions, decodeGeneratedSemanticResult } from '../src/music/semantic/classify.js';
import { validateSemanticContract } from '../src/music/semantic/canonical-contract.js';
import canonicalSpec from '../src/music/semantic/semantic-output-v1.json' with { type: 'json' };
import conformance from '../src/music/semantic/semantic-output-v1.conformance.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../src/music/semantic/cli.ts');

const track = {
  id: 'track-1',
  title: 'Track',
  artist: 'Artist',
  album: 'Album',
  year: 2015,
  genres: ['Ambient', 'Electronic'],
  evidence: '{"semantic_prompt_readiness":"PROMPT_BASIC"}',
};

function mockRequest() {
  const inputSha = semanticInputSha256([track]);
  return {
    protocol_version: PROTOCOL_VERSION,
    contract_version: CONTRACT_VERSION,
    batch_id: 'batch-1',
    run_manifest: {
      provider: 'mock',
      model: 'mock-semantic-v1',
      reasoning: FROZEN_REASONING,
      temperature: FROZEN_TEMPERATURE,
      semantic_experiment_version: SEMANTIC_EXPERIMENT_VERSION,
      prompt_version: EXPECTED_PROMPT_STATIC_SHA256,
      schema_version: SCHEMA_VERSION,
      renderer_version: RENDERER_VERSION,
      prompt_static_sha256: EXPECTED_PROMPT_STATIC_SHA256,
      schema_sha256: EXPECTED_SCHEMA_SHA256,
      contract_sha256: EXPECTED_CONTRACT_SHA256,
      renderer_sha256: EXPECTED_RENDERER_SHA256,
      semantic_input_sha256: inputSha,
      semantic_run_fingerprint: semanticRunFingerprint(
        'mock',
        'mock-semantic-v1',
         FROZEN_TEMPERATURE,
         FROZEN_REASONING,
         inputSha,
          SEMANTIC_EXPERIMENT_VERSION,
       ),
      decoder_version: DECODER_VERSION,
      input_material: track,
    },
    tracks: [track],
  };
}

test('semantic runtime static hashes match the frozen Coyote contract', () => {
  assert.equal(EXPECTED_PROMPT_STATIC_SHA256, "0a4dea68e32b5c1358c9635a2a00ef55a0cdfc0126456c6d9f70a9a3f3949bfc");
  assert.equal(EXPECTED_SCHEMA_SHA256, "0512f5223a0f29216f9877d9140bf53f44aef013e42ea324ad7f57f4c31b7660");
  assert.equal(EXPECTED_CONTRACT_SHA256, "1a29d57f04f596b88cc592ca860494cb3601bb413b02e53d4bcdc7b8d074743b");
  assert.equal(EXPECTED_RENDERER_SHA256, "05867072f05d7caeb524414fe818af692a5af703bb4e04741a74dc81c5936016");
  assert.equal(
    semanticInputSha256([track]),
    '93ebbe1c7477c5070be75a20642df14b94e9a85ac7c84d313fce1957ef8c3f93',
  );
  const v112Fingerprint = semanticRunFingerprint(
    'mock',
    'mock-semantic-v1',
    FROZEN_TEMPERATURE,
    FROZEN_REASONING,
    semanticInputSha256([track]),
    SEMANTIC_EXPERIMENT_VERSION,
  );
  assert.equal(
    v112Fingerprint,
    semanticRunFingerprint(
      'mock',
      'mock-semantic-v1',
      FROZEN_TEMPERATURE,
      FROZEN_REASONING,
      semanticInputSha256([track]),
      SEMANTIC_EXPERIMENT_VERSION,
    ),
  );
  assert.notEqual(
    v112Fingerprint,
    semanticRunFingerprint(
      'mock',
      'mock-semantic-v1',
      FROZEN_TEMPERATURE,
      FROZEN_REASONING,
      semanticInputSha256([track]),
      'v1.8',
    ),
  );
  assert.ok(PROMPT_STATIC.includes('Bittersweet is valid only when all three gate values are Y'));
});

test('canonical semantic contract conformance matches the vendored corpus', () => {
  assert.equal(canonicalSpec.contract_version, 'semantic-output-v1');
  assert.equal(createHash('sha256').update(readFileSync(join(here, '../src/music/semantic/semantic-output-v1.json'))).digest('hex'), 'bd59a63f52b427f29f12ef844d4c4ab51e7eadf547dcf26d83f9107c26e60ba1');
  for (const fixture of conformance.fixtures) {
    const verdict = validateSemanticContract(fixture.result);
    assert.equal(verdict.structuralValid, fixture.structural_valid, fixture.id);
    assert.equal(verdict.semanticValid, fixture.semantic_valid, fixture.id);
    assert.equal(verdict.code, fixture.failure_code ?? null, fixture.id);
  }
});

test('V1.12 stock request carries no custom OpenRouter routing or session controls', () => {
  const options = buildSemanticGenerationOptions({}, track);
  assert.equal('providerOptions' in options, false);
  assert.equal('headers' in options, false);
  assert.equal(options.temperature, FROZEN_TEMPERATURE);
  assert.equal(options.maxOutputTokens, 2048);
  assert.equal(options.instructions, PROMPT_STATIC);
  assert.ok(options.output, 'strict structured output remains configured');
});

test('V1.12 stock request serializes no custom OpenRouter routing or session fields', async () => {
  let captured: { body: any; headers: Headers } | undefined;
  const moods = Object.fromEntries(SEMANTIC_MOODS.map((mood) => [mood, ['N']]));
  const model = createOpenRouter({
    apiKey: 'synthetic-only',
    fetch: async (_url, init) => {
      captured = { body: JSON.parse(init?.body as string), headers: new Headers(init?.headers) };
      return new Response(JSON.stringify({
        id: 'synthetic-stock',
        model: FROZEN_MODEL,
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ id: track.id, e: 'I', m: moods, b: ['N', 'N', 'N'] }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { 'content-type': 'application/json' } });
    },
  })(FROZEN_MODEL, { reasoning: { enabled: false } });
  await generateText(buildSemanticGenerationOptions(model, track));
  assert.equal(captured?.body.model, FROZEN_MODEL);
  assert.equal(captured?.body.provider, undefined);
  assert.equal(captured?.body.session_id, undefined);
  assert.equal(captured?.headers.has('x-session-id'), false);
  assert.equal(captured?.body.response_format.json_schema.strict, true);
  assert.equal(captured?.body.temperature, FROZEN_TEMPERATURE);
  assert.equal(captured?.body.max_tokens, 2048);
  assert.equal(captured?.body.reasoning.enabled, false);
});

test('semantic request validation accepts the frozen mock fingerprint and rejects model drift', () => {
  const request = SemanticRequestSchema.parse(mockRequest());
  assert.doesNotThrow(() => validateFrozenRequest(request, true));

  const drifted = structuredClone(mockRequest());
  drifted.run_manifest.model = 'some-other-model';
  const parsed = SemanticRequestSchema.parse(drifted);
  assert.throws(() => validateFrozenRequest(parsed, true), /PROVIDER_PINNING_UNAVAILABLE/);
});

test('semantic CLI mock is strict stdout JSON and performs no provider call', () => {
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', cli],
    {
      input: JSON.stringify(mockRequest()),
      encoding: 'utf8',
      env: {
        ...process.env,
        SUBWAVE_SEMANTIC_MOCK: '1',
        OPENROUTER_API_KEY: '',
      },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const response = JSON.parse(lines[0]);
  assert.equal(response.protocol_version, 1);
  assert.equal(response.provider, 'mock');
  assert.equal(response.model, 'mock-semantic-v1');
  assert.equal(response.semantic_input_sha256, mockRequest().run_manifest.semantic_input_sha256);
  assert.equal(response.semantic_run_fingerprint, mockRequest().run_manifest.semantic_run_fingerprint);
  assert.deepEqual(response.results, [{
    id: 'track-1',
    e: 'S',
    m: {
      Serene: ['N'],
       Warm: ['Y', 'M'],
      Bright: ['N'],
      Playful: ['N'],
      Bittersweet: ['N'],
      Melancholic: ['N'],
      Dark: ['N'],
      Tense: ['N'],
      Wonder: ['N'],
    },
    b: ['N', 'N', 'N'],
  }]);
});

test('semantic no-output compatibility recovers only from the same call and stays strict', () => {
  const expected = {
    id: 'track-1',
    e: 'S',
    m: {
      Serene: ['N'],
      Warm: ['N'],
      Bright: ['N'],
      Playful: ['N'],
      Bittersweet: ['N'],
      Melancholic: ['N'],
      Dark: ['N'],
      Tense: ['N'],
      Wonder: ['N'],
    },
    b: ['N', 'N', 'N'],
  };

  assert.deepEqual(decodeGeneratedSemanticResult({ output: expected }), expected);

  const recovered = decodeGeneratedSemanticResult({
    get output() { throw new Error('No output generated.'); },
    text: `\n\`\`\`json\n${JSON.stringify(expected)}\n\`\`\`\n`,
    finishReason: 'other',
    rawFinishReason: 'provider-specific-stop',
  });
  assert.deepEqual(recovered, expected);

  assert.throws(
    () => decodeGeneratedSemanticResult({
      get output() { throw new Error('No output generated.'); },
      text: JSON.stringify(expected),
      finishReason: 'length',
      rawFinishReason: 'length',
    }),
    /SEMANTIC_OUTPUT_TRUNCATED/,
  );

  assert.throws(
    () => decodeGeneratedSemanticResult({
      get output() { throw new Error('No output generated.'); },
      text: '{not-json}',
      finishReason: 'other',
      rawFinishReason: 'unknown',
    }),
    /SCHEMA_FAILURE: same-call semantic text recovery failed/,
  );
});

test('semantic seam stays isolated from durable/editorial write paths', () => {
  const classify = readFileSync(join(here, '../src/music/semantic/classify.ts'), 'utf8');
  const cliSource = readFileSync(join(here, '../src/music/semantic/cli.ts'), 'utf8');
  for (const forbidden of [
    'tagger-core',
    'tag-library',
    'library-db',
    'coyote/client',
    'setTrackEditorialMoods',
  ]) {
    assert.equal(classify.includes(forbidden), false, `classify.ts must not import/use ${forbidden}`);
  }
  assert.ok(classify.includes('settings.llmKeyFor(FROZEN_PROVIDER)'));
  assert.ok(classify.includes('process.env.OPENROUTER_API_KEY'));
  assert.ok(cliSource.includes('SUBWAVE_STATE_DIR'));
  assert.ok(cliSource.includes('SUBWAVE_ENV_FILE'));
  assert.ok(cliSource.includes('parseDotEnv'));
  assert.ok(cliSource.includes('OPENROUTER_API_KEY'));
});
