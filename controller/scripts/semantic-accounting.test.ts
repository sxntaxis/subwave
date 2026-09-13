import assert from 'node:assert/strict';
import { classifySemantic } from '../src/music/semantic/classify.js';
import {
  CONTRACT_VERSION,
  EXPECTED_CONTRACT_SHA256,
  EXPECTED_PROMPT_STATIC_SHA256,
  EXPECTED_RENDERER_SHA256,
  EXPECTED_SCHEMA_SHA256,
  PROTOCOL_VERSION,
  RENDERER_VERSION,
  SCHEMA_VERSION,
  SEMANTIC_EXPERIMENT_VERSION,
  semanticInputSha256,
  semanticRunFingerprint,
} from '../src/music/semantic/contract-v2.js';

const track = { id: 'provider-accounting-fixture', title: 'Fixture', artist: 'Fixture', album: 'Fixture', year: null, genres: [], evidence: '' };
const inputMaterial = track;
const inputHash = semanticInputSha256([track]);
const request = {
  protocol_version: PROTOCOL_VERSION,
  contract_version: CONTRACT_VERSION,
  batch_id: 'provider-accounting-fixture-batch',
  run_manifest: {
    provider: 'mock', model: 'mock-semantic-v1', reasoning: 'disabled', temperature: 0.2,
    semantic_experiment_version: SEMANTIC_EXPERIMENT_VERSION, prompt_version: EXPECTED_PROMPT_STATIC_SHA256,
    schema_version: SCHEMA_VERSION, renderer_version: RENDERER_VERSION,
    prompt_static_sha256: EXPECTED_PROMPT_STATIC_SHA256, schema_sha256: EXPECTED_SCHEMA_SHA256,
    contract_sha256: EXPECTED_CONTRACT_SHA256, renderer_sha256: EXPECTED_RENDERER_SHA256,
    semantic_input_sha256: inputHash,
    semantic_run_fingerprint: semanticRunFingerprint('mock', 'mock-semantic-v1', 0.2, 'disabled', inputHash, SEMANTIC_EXPERIMENT_VERSION),
    decoder_version: 'semantic-decoder-v2', input_material: inputMaterial,
  },
  tracks: [track],
};

const response = await classifySemantic(request, true);
assert.equal(response.provider_calls, 0);
console.log('semantic accounting fixture: PASS');
