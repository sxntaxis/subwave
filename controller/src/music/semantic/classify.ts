import { djObject } from '../../llm/sdk.js';
import * as settings from '../../settings.js';
import {
  CONTRACT_VERSION,
  EXPECTED_CONTRACT_SHA256,
  EXPECTED_PROMPT_STATIC_SHA256,
  EXPECTED_RENDERER_SHA256,
  EXPECTED_SCHEMA_SHA256,
  FROZEN_MODEL,
  FROZEN_PROVIDER,
  FROZEN_REASONING,
  FROZEN_TEMPERATURE,
  PROTOCOL_VERSION,
  RENDERER_VERSION,
  SCHEMA_VERSION,
  SEMANTIC_EXPERIMENT_VERSION,
  SEMANTIC_MOODS,
  SemanticTrackResultSchema,
  semanticInputSha256,
  semanticRunFingerprint,
  stableJson,
  validateFrozenRequest,
  type SemanticRequest,
  type SemanticResponse,
  type SemanticTrackResult,
} from './contract-v2.js';
import { PROMPT_STATIC, assertFrozenPrompt } from './prompt-v2.js';
import { validateSemanticContract } from './canonical-contract.js';

const MAX_OUTPUT_TOKENS = 2048;

export type SemanticClassifyOptions = {
  onRawResult?: (result: SemanticTrackResult) => void;
};

function mockResult(id: string): SemanticTrackResult {
  const m = Object.fromEntries(SEMANTIC_MOODS.map((mood) => [mood, ['N']]));
  m.Warm = ['Y', 'M'];
  return SemanticTrackResultSchema.parse({
    id,
    e: 'S',
    m,
    b: ['N', 'N', 'N'],
  });
}

function responseBase(request: SemanticRequest, provider: string, model: string) {
  const inputSha256 = semanticInputSha256(request.tracks);
  return {
    protocol_version: PROTOCOL_VERSION,
    contract_version: CONTRACT_VERSION,
    batch_id: request.batch_id,
    provider,
    model,
    actual_provider: provider,
    actual_model: model,
    actual_temperature: FROZEN_TEMPERATURE,
    actual_reasoning: FROZEN_REASONING,
    semantic_experiment_version: SEMANTIC_EXPERIMENT_VERSION,
    schema_version: SCHEMA_VERSION,
    renderer_version: RENDERER_VERSION,
    prompt_static_sha256: EXPECTED_PROMPT_STATIC_SHA256,
    schema_sha256: EXPECTED_SCHEMA_SHA256,
    contract_sha256: EXPECTED_CONTRACT_SHA256,
    renderer_sha256: EXPECTED_RENDERER_SHA256,
    semantic_input_sha256: inputSha256,
    semantic_run_fingerprint: semanticRunFingerprint(
      provider,
      model,
      FROZEN_TEMPERATURE,
      FROZEN_REASONING,
      inputSha256,
      SEMANTIC_EXPERIMENT_VERSION,
    ),
  };
}

export function buildSemanticGenerationOptions(track: SemanticRequest['tracks'][number]) {
  return {
    system: PROMPT_STATIC,
    // No unversioned wrapper prose: the dynamic prompt is exactly the sanitized
    // evidence object whose content is covered by semantic_input_sha256.
    prompt: stableJson(track),
    temperature: FROZEN_TEMPERATURE,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    schema: SemanticTrackResultSchema,
    kind: 'semantic.classify',
  };
}

export async function classifySemantic(
  request: SemanticRequest,
  mock: boolean,
  options: SemanticClassifyOptions = {},
): Promise<SemanticResponse> {
  assertFrozenPrompt();
  validateFrozenRequest(request, mock);

  const track = request.tracks[0];
  if (mock) {
    const result = mockResult(track.id);
    options.onRawResult?.(result);
    return {
      ...responseBase(request, 'mock', 'mock-semantic-v1'),
      provider_calls: 0,
      structural_schema_valid: true,
      semantic_contract_valid: true,
      semantic_outcome: 'VALID',
      results: [result],
    };
  }

  let providerCalls = 0;
  try {
    await settings.load();
    const llm = settings.get().llm;
    if (llm?.provider !== FROZEN_PROVIDER || llm?.model !== FROZEN_MODEL || llm?.reasoning === true) {
      throw new Error(`PROVIDER_PINNING_UNAVAILABLE: expected ${FROZEN_PROVIDER}:${FROZEN_MODEL} reasoning=${FROZEN_REASONING}`);
    }
    const result = await djObject({
      ...buildSemanticGenerationOptions(track),
      onProviderCall: () => { providerCalls += 1; },
    });
    options.onRawResult?.(result);
    if (result.id !== track.id) {
      throw new Error('SCHEMA_FAILURE: track id');
    }
    const contract = validateSemanticContract(result);
    if (!contract.semanticValid) {
      throw new Error(
        `SEMANTIC_CONTRACT_FAILURE: code=${contract.code}; structural_schema_valid=${contract.structuralValid}; semantic_contract_valid=false`,
      );
    }

    return {
      ...responseBase(request, FROZEN_PROVIDER, FROZEN_MODEL),
      provider_calls: providerCalls,
      structural_schema_valid: true,
      semantic_contract_valid: true,
      semantic_outcome: 'VALID',
      results: [result],
    };
  } catch (error) {
    if (error && typeof error === 'object') {
      (error as { provider_calls?: number }).provider_calls = providerCalls;
    }
    throw error;
  }
}
