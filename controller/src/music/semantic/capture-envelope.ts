import {
  SemanticTrackResultSchema,
  type SemanticResponse,
  type SemanticTrackResult,
} from './contract-v2.js';
import { validateSemanticContract } from './canonical-contract.js';

export type SemanticCaptureEnvelope = {
  capture_protocol_version: 1;
  response: SemanticResponse | null;
  raw_semantic_result: SemanticTrackResult | null;
  structural_schema_valid: boolean | null;
  semantic_contract_valid: boolean | null;
  semantic_failure_code: string | null;
  error: string | null;
};

export function buildSemanticCaptureEnvelope(
  response: SemanticResponse | null,
  rawResult: SemanticTrackResult | null,
  error: string | null,
): SemanticCaptureEnvelope {
  const structural = rawResult === null ? null : SemanticTrackResultSchema.safeParse(rawResult);
  const contract = structural?.success ? validateSemanticContract(rawResult) : null;
  const failureCode = contract?.semanticValid === false
    ? contract.code
    : error?.match(/code=([^;\s]+)/)?.[1] ?? null;
  return {
    capture_protocol_version: 1,
    response,
    raw_semantic_result: rawResult,
    structural_schema_valid: structural === null ? null : structural.success,
    semantic_contract_valid: contract === null ? null : contract.semanticValid,
    semantic_failure_code: failureCode,
    error,
  };
}
