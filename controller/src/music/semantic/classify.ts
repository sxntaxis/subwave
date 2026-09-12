import { generateText, Output } from 'ai';
import { languageModel } from '../../llm/provider.js';
import * as settings from '../../settings.js';
import { withTransientRetry } from '../../llm/internal/core/retry.js';
import { extractJson, stripThinking } from '../../llm/internal/core/pure.js';
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
} from './contract.js';
import { PROMPT_STATIC, assertFrozenPrompt } from './prompt.js';
import { validateSemanticContract } from './canonical-contract.js';

const MAX_OUTPUT_TOKENS = 2048;

function isNoOutputGeneratedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === 'No output generated.'
    || error.name === 'AI_NoOutputGeneratedError'
    || error.name === 'NoOutputGeneratedError';
}

function scalarDiagnostic(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return 'unknown';
}

export function decodeGeneratedSemanticResult(generated: any): SemanticTrackResult {
  try {
    return SemanticTrackResultSchema.parse(generated.output);
  } catch (error) {
    if (!isNoOutputGeneratedError(error)) throw error;
  }

  // AI SDK 7 only materializes Output.object when the final finishReason is
  // `stop`. OpenRouter can still leave usable text on the same completed call.
  // Recover only from that already-returned text: never issue a second provider
  // request, never change the prompt/model/schema, and still require the exact
  // frozen Zod contract.
  const text = typeof generated?.text === 'string' ? generated.text : '';
  const finishReason = scalarDiagnostic(generated?.finishReason);
  const rawFinishReason = scalarDiagnostic(generated?.rawFinishReason);

  if (!text.trim()) {
    throw new Error(
      `SEMANTIC_NO_OUTPUT: finishReason=${finishReason}; rawFinishReason=${rawFinishReason}; text_length=0`,
    );
  }
  if (finishReason === 'length') {
    throw new Error(
      `SEMANTIC_OUTPUT_TRUNCATED: finishReason=length; rawFinishReason=${rawFinishReason}; text_length=${text.length}`,
    );
  }

  try {
    return SemanticTrackResultSchema.parse(JSON.parse(extractJson(stripThinking(text))));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(
      `SCHEMA_FAILURE: same-call semantic text recovery failed; finishReason=${finishReason}; `
      + `rawFinishReason=${rawFinishReason}; text_length=${text.length}; `
      + `text_preview=${JSON.stringify(preview)}; parse=${detail}`,
    );
  }
}

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

export function buildSemanticGenerationOptions(model: any, track: SemanticRequest['tracks'][number]) {
  return {
    model,
    instructions: PROMPT_STATIC,
    // No unversioned wrapper prose: the dynamic prompt is exactly the sanitized
    // evidence object whose content is covered by semantic_input_sha256.
    prompt: stableJson(track),
    temperature: FROZEN_TEMPERATURE,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    output: Output.object({ schema: SemanticTrackResultSchema }),
  };
}

export async function classifySemantic(request: SemanticRequest, mock: boolean): Promise<SemanticResponse> {
  assertFrozenPrompt();
  validateFrozenRequest(request, mock);

  const track = request.tracks[0];
  if (mock) {
    return {
      ...responseBase(request, 'mock', 'mock-semantic-v1'),
      structural_schema_valid: true,
      semantic_contract_valid: true,
      semantic_outcome: 'VALID',
      results: [mockResult(track.id)],
    };
  }

  // Reuse SubWave's normal credential precedence: an inline per-provider key
  // from settings first, then the provider env key injected by Compose. The CLI
  // may populate that env slot from SubWave's own .env before this module loads.
  // Coyote carries only file paths and never receives the secret value.
  await settings.load();
  const apiKey = settings.llmKeyFor(FROZEN_PROVIDER)
    || process.env.OPENROUTER_API_KEY?.trim()
    || '';
  if (!apiKey) {
    throw new Error('PROVIDER_AUTH_FAILURE: SubWave has no effective OpenRouter credential');
  }

  // Use SubWave's provider registry to construct the exact OpenRouter model,
  // but deliberately bypass withFailover: a frozen semantic run may retry the
  // same provider on a transient blip, never switch provider/model.
  const cfg = {
    provider: FROZEN_PROVIDER,
    model: FROZEN_MODEL,
    apiKey,
    reasoning: false,
    ollamaUrl: '',
    baseUrl: '',
  };
  const model = languageModel(cfg, { forceNoThink: true });

  const generate = () => generateText({
    ...buildSemanticGenerationOptions(model, track),
    ...(process.env.SUBWAVE_SEMANTIC_NO_RETRY === '1' ? { maxRetries: 0 } : {}),
  });
  const generated: any = process.env.SUBWAVE_SEMANTIC_NO_RETRY === '1'
    ? await generate()
    : await withTransientRetry('semantic.classify', generate);
  const result = decodeGeneratedSemanticResult(generated);
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
    structural_schema_valid: true,
    semantic_contract_valid: true,
    semantic_outcome: 'VALID',
    results: [result],
  };
}
