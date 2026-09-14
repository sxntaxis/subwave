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
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const MAX_OUTPUT_TOKENS = 2048;
const OPENROUTER_PROVIDER_OPTIONS = {
  openrouter: {
    provider: {
      ignore: ['open-inference', 'deepinfra'],
      allow_fallbacks: true,
      require_parameters: true,
    },
  },
} as const;

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
    maxRetries: 0,
    providerOptions: OPENROUTER_PROVIDER_OPTIONS,
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
  let providerAttempt = 0;
  const timingFile = process.env.COYOTE_PROVIDER_TIMING_FILE;
  const budgetPath = process.env.COYOTE_PROVIDER_BUDGET_FILE;
  const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const timing = (event: Record<string, unknown>) => {
    if (!timingFile) return;
    const slash = timingFile.lastIndexOf('/');
    if (slash > 0) mkdirSync(timingFile.slice(0, slash), { recursive: true });
    appendFileSync(timingFile, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
  };
  const reserveProviderCall = (meta: { via?: string } = {}) => {
    if (budgetPath) {
      const lock = `${budgetPath}.lock`;
      for (;;) {
        try { mkdirSync(lock); break; } catch { sleepSync(2); }
      }
      try {
        const state = JSON.parse(readFileSync(budgetPath, 'utf8')) as { used: number; limit: number };
        if (state.used >= state.limit) throw new Error('PROVIDER_CALL_BUDGET_EXHAUSTED');
        state.used += 1;
        const tmp = `${budgetPath}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(state)}\n`, { encoding: 'ascii' });
        renameSync(tmp, budgetPath);
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    }
    const attempt = ++providerAttempt;
    const token = { attempt, startedAt: new Date().toISOString(), via: meta.via ?? null };
    timing({ phase: 'provider_start', trackId: track.id, ...token });
    providerCalls += 1;
    const accountingFile = process.env.COYOTE_PROVIDER_ACCOUNTING_FILE;
    if (accountingFile) writeFileSync(accountingFile, `${providerCalls}\n`, { encoding: 'ascii', flag: 'w' });
    return token;
  };
  const finishProviderCall = (
    token: { attempt: number; startedAt: string; via: string | null } | undefined,
    outcome?: { result?: any; error?: any },
  ) => {
    if (!token) return;
    const result = outcome?.result;
    const error = outcome?.error;
    const generationId = typeof result?.response?.id === 'string'
      ? result.response.id
      : typeof error?.response?.id === 'string' ? error.response.id : null;
    const routedProvider = typeof result?.providerMetadata?.openrouter?.provider === 'string'
      ? result.providerMetadata.openrouter.provider
      : null;
    timing({
      phase: 'provider_end',
      trackId: track.id,
      attempt: token.attempt,
      startedAt: token.startedAt,
      endedAt: new Date().toISOString(),
      via: token.via,
      generationId,
      routedProvider,
      finishReason: typeof result?.finishReason === 'string' ? result.finishReason : typeof error?.finishReason === 'string' ? error.finishReason : null,
    });
  };
  try {
    await settings.load();
    const llm = settings.get().llm;
    if (llm?.provider !== FROZEN_PROVIDER || llm?.model !== FROZEN_MODEL || llm?.reasoning === true) {
      throw new Error(`PROVIDER_PINNING_UNAVAILABLE: expected ${FROZEN_PROVIDER}:${FROZEN_MODEL} reasoning=${FROZEN_REASONING}`);
    }
    const result = await djObject({
      ...buildSemanticGenerationOptions(track),
       onProviderCall: reserveProviderCall,
       onProviderCallEnd: finishProviderCall,
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
