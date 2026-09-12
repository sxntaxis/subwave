import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CONTRACT_VERSION,
  DECODER_VERSION,
  EXPECTED_CONTRACT_SHA256,
  EXPECTED_PROMPT_STATIC_SHA256,
  EXPECTED_RENDERER_SHA256,
  EXPECTED_SCHEMA_SHA256,
  FROZEN_REASONING,
  FROZEN_TEMPERATURE,
  PROTOCOL_VERSION,
  RENDERER_VERSION,
  SCHEMA_VERSION,
  SEMANTIC_EXPERIMENT_VERSION,
  SEMANTIC_MOODS,
  SemanticTrackResultSchema,
  SemanticRequestSchema,
  semanticInputSha256,
  semanticRunFingerprint,
  validateFrozenRequest,
} from '../src/music/semantic/contract.js';
import { PROMPT_STATIC } from '../src/music/semantic/prompt.js';
import { buildSemanticGenerationOptions } from '../src/music/semantic/classify.js';
import { validateSemanticContract } from '../src/music/semantic/canonical-contract.js';
import { schemaHint } from '../src/llm/internal/core/pure.js';
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
  assert.equal(createHash('sha256').update(readFileSync(join(here, '../src/music/semantic/semantic-output-v1.json'))).digest('hex'), 'c371990c4baef3f72de8649152eed0feb460d94d3075bb143261f38a9b593aaa');
  for (const fixture of conformance.fixtures) {
    const verdict = validateSemanticContract(fixture.result);
    assert.equal(verdict.structuralValid, fixture.structural_valid, fixture.id);
    assert.equal(verdict.semanticValid, fixture.semantic_valid, fixture.id);
    assert.equal(verdict.code, fixture.failure_code ?? null, fixture.id);
  }
});

test('V1.14 semantic seam uses the authority djObject transport with no request controls', () => {
  const options = buildSemanticGenerationOptions(track);
  assert.equal('providerOptions' in options, false);
  assert.equal('headers' in options, false);
  assert.equal('model' in options, false);
  assert.equal('session_id' in options, false);
  assert.equal(options.temperature, FROZEN_TEMPERATURE);
  assert.equal(options.maxOutputTokens, 2048);
  assert.equal(options.system, PROMPT_STATIC);
  assert.equal(options.schema, SemanticTrackResultSchema);
  assert.equal(
    createHash('sha256').update(readFileSync(join(here, '../src/llm/internal/strategy/object.ts'))).digest('hex'),
    '7ed6c6d290c0daf4565825ee128f2cc44e4a9db055a1dac0fda3a895815b903f',
  );
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

test('semantic canonical validation remains a post-stock structural step', () => {
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

  const structural = SemanticTrackResultSchema.parse(expected);
  const verdict = validateSemanticContract(structural);
  assert.equal(verdict.structuralValid, true);
  assert.equal(verdict.semanticValid, true);
  assert.equal(verdict.code, null);
});

test('b presentation is explicit without changing canonical acceptance', () => {
  const valid = {
    id: 'track-1', e: 'S',
    m: Object.fromEntries(SEMANTIC_MOODS.map((mood) => [mood, ['N']])),
    b: ['Y', 'N', 'U'],
  };
  assert.equal(SemanticTrackResultSchema.safeParse(valid).success, true);
  assert.equal(SemanticTrackResultSchema.safeParse({ ...valid, b: { warmth: 'Y', melancholy: 'N', coexistence: 'U' } }).success, false);
  assert.equal(SemanticTrackResultSchema.safeParse({ ...valid, b: ['Y', 'N'] }).success, false);
  assert.equal(SemanticTrackResultSchema.safeParse({ ...valid, b: ['Y', 'N', 'U', 'N'] }).success, false);
  assert.equal(SemanticTrackResultSchema.safeParse({ ...valid, b: ['Y', 'M', 'U'] }).success, false);
  const bittersweet = { ...valid, m: { ...valid.m, Bittersweet: ['Y', 'M'] }, b: ['Y', 'N', 'U'] };
  assert.deepEqual(validateSemanticContract(bittersweet), {
    structuralValid: true,
    semanticValid: false,
    code: 'SEMANTIC_CONTRACT_BITTERSWEET_GATE',
    result: bittersweet,
  });
});

test('stock recovery schema hint exposes ordered b presentation', () => {
  const hint = schemaHint(SemanticTrackResultSchema);
  assert.ok(hint);
  const schema = JSON.parse(hint);
  const b = schema.properties.b;
  assert.equal(b.type, 'array');
  assert.deepEqual(b.items, { not: {} });
  assert.equal(b.prefixItems.length, 3);
  assert.deepEqual(b.prefixItems.map((item: any) => item.enum), [['Y', 'N', 'U'], ['Y', 'N', 'U'], ['Y', 'N', 'U']]);
  assert.match(b.title, /WARMTH_AFFILIATION.*MELANCHOLY_LONGING.*MIXED_VALENCE_COEXISTENCE/);
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
  assert.ok(classify.includes('djObject(buildSemanticGenerationOptions(track))'));
  assert.ok(cliSource.includes('SUBWAVE_STATE_DIR'));
  assert.ok(cliSource.includes('SUBWAVE_ENV_FILE'));
  assert.ok(cliSource.includes('parseDotEnv'));
  assert.ok(cliSource.includes('OPENROUTER_API_KEY'));
});
