import { generateText, NoObjectGeneratedError, Output } from 'ai';
import { withTransientRetry } from '../../llm/internal/core/retry.js';
import { extractJson, schemaHint, stripThinking } from '../../llm/internal/core/pure.js';
import { reasoningFor } from '../../llm/internal/provider/capabilities.js';
import {
  FROZEN_TEMPERATURE,
  SemanticTrackResultSchema,
  stableJson,
  type SemanticInputTrack,
  type SemanticTrackResult,
} from './contract-v2.js';

export const SEMANTIC_ONE_CALL_MAX_OUTPUT_TOKENS = 2048;

export type SemanticOneCallHooks = {
  onProviderCall?: (meta: { via: string }) => any;
  onProviderCallEnd?: (token: any, outcome: { result?: any; error?: any }) => void;
};

function isNoOutputGeneratedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (NoObjectGeneratedError.isInstance(error)) return true;
  return error.message === 'No output generated.'
    || error.message.startsWith('No object generated')
    || error.name === 'AI_NoOutputGeneratedError'
    || error.name === 'NoOutputGeneratedError'
    || error.name === 'NoObjectGeneratedError';
}

function scalarDiagnostic(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return 'unknown';
}

// Decode the text returned by the same provider response when AI SDK did not
// materialize Output.object. This function never owns a second generation.
export function decodeGeneratedSemanticResult(generated: any): SemanticTrackResult {
  try {
    const output = generated?.output;
    if (output === undefined) throw Object.assign(new Error('No output generated.'), { name: 'AI_NoOutputGeneratedError' });
    return SemanticTrackResultSchema.parse(output);
  } catch (error) {
    if (!isNoOutputGeneratedError(error)) throw error;
  }

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

export function buildSemanticOneCallGenerationOptions(
  system: string,
  track: SemanticInputTrack,
  schema = SemanticTrackResultSchema,
  providerOptions: unknown = undefined,
) {
  return {
    instructions: system,
    prompt: stableJson(track),
    temperature: FROZEN_TEMPERATURE,
    maxOutputTokens: SEMANTIC_ONE_CALL_MAX_OUTPUT_TOKENS,
    maxRetries: 0,
    ...(providerOptions === undefined ? {} : { providerOptions }),
    output: Output.object({ schema }),
  };
}

export async function generateSemanticOneCall({
  model,
  system,
  track,
  providerOptions,
  onProviderCall,
  onProviderCallEnd,
  generate = generateText,
}: {
  model: any;
  system: string;
  track: SemanticInputTrack;
  providerOptions?: unknown;
  generate?: (options: any) => Promise<any>;
} & SemanticOneCallHooks): Promise<SemanticTrackResult> {
  const invoke = async () => {
    const token = onProviderCall?.({ via: 'semantic:one-call' });
    let outcome: { result?: any; error?: any } | undefined;
    try {
      let result: any;
      try {
        result = await generate({
          ...buildSemanticOneCallGenerationOptions(system, track, SemanticTrackResultSchema, providerOptions),
          model,
        });
      } catch (error: any) {
        if (!isNoOutputGeneratedError(error)) throw error;
        // AI SDK versions differ: some reject generateText with
        // NoObjectGeneratedError while others return a result whose output
        // accessor raises. Both still carry the text from this same call.
        result = {
          get output(): never { throw error; },
          text: error.text || '',
          finishReason: error.finishReason,
          rawFinishReason: error.rawFinishReason,
        };
      }
      outcome = { result };
      return result;
    } catch (error) {
      outcome = outcome?.result ? { ...outcome, error } : { error };
      throw error;
    } finally {
      onProviderCallEnd?.(token, outcome || {});
    }
  };

  const generated = await withTransientRetry('semantic.classify', invoke);
  return decodeGeneratedSemanticResult(generated);
}

export function buildSemanticRecoveryOnlyGenerationOptions(
  system: string,
  track: SemanticInputTrack,
  schema = SemanticTrackResultSchema,
  providerOptions: unknown = undefined,
  providerConfig: unknown = undefined,
) {
  const hint = schemaHint(schema);
  return {
    instructions: system,
    prompt: `${stableJson(track)}\n\nRespond with a single JSON object only — no prose, no markdown fences.`
      + (hint ? ` It MUST validate against this JSON Schema — every required key must be present:\n${hint}` : ''),
    temperature: FROZEN_TEMPERATURE,
    maxOutputTokens: SEMANTIC_ONE_CALL_MAX_OUTPUT_TOKENS,
    maxRetries: 0,
    ...(providerOptions === undefined ? {} : { providerOptions }),
    reasoning: reasoningFor(providerConfig, { forceNoThink: true }),
  };
}

export async function generateSemanticRecoveryOnly({
  model,
  system,
  track,
  schema = SemanticTrackResultSchema,
  providerOptions,
  providerConfig,
  onProviderCall,
  onProviderCallEnd,
  generate = generateText,
}: {
  model: any;
  system: string;
  track: SemanticInputTrack;
  schema?: any;
  providerOptions?: unknown;
  providerConfig?: unknown;
  generate?: (options: any) => Promise<any>;
} & SemanticOneCallHooks): Promise<SemanticTrackResult> {
  const invoke = async () => {
    const token = onProviderCall?.({ via: 'semantic:recovery-only' });
    let outcome: { result?: any; error?: any } | undefined;
    try {
      const result = await generate({
        ...buildSemanticRecoveryOnlyGenerationOptions(system, track, schema, providerOptions, providerConfig),
        model,
      });
      outcome = { result };
      try {
        return schema.parse(JSON.parse(extractJson(stripThinking(result.text))));
      } catch (parseError: any) {
        parseError.text = result.text || '';
        parseError.finishReason = result.finishReason;
        parseError.usage = result.usage;
        throw parseError;
      }
    } catch (error) {
      outcome = outcome?.result ? { ...outcome, error } : { error };
      throw error;
    } finally {
      onProviderCallEnd?.(token, outcome || {});
    }
  };

  return withTransientRetry('semantic.classify', invoke);
}
