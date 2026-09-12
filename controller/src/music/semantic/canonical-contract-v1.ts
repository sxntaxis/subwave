import canonicalSpec from './semantic-output-v1.json' with { type: 'json' };
import {
  SemanticTrackResultSchema,
  SEMANTIC_MOODS,
  sha256Text,
  stableJson,
  type SemanticTrackResult,
} from './contract.js';

export const CANONICAL_CONTRACT_VERSION = canonicalSpec.contract_version;
export const CANONICAL_CONTRACT_SPEC_HASH = sha256Text(stableJson(canonicalSpec));

export type SemanticContractValidation = {
  structuralValid: boolean;
  semanticValid: boolean;
  code: string | null;
  result?: SemanticTrackResult;
};

export function validateSemanticContract(value: unknown): SemanticContractValidation {
  const parsed = SemanticTrackResultSchema.safeParse(value);
  if (!parsed.success) return { structuralValid: false, semanticValid: false, code: 'STRUCTURAL_CONTRACT_FAILURE' };
  const result = parsed.data;
  if (result.m.Bittersweet[0] === 'Y' && stableJson(result.b) !== stableJson(['Y', 'Y', 'Y'])) {
    return { structuralValid: true, semanticValid: false, code: 'SEMANTIC_CONTRACT_BITTERSWEET_GATE', result };
  }
  const positiveLabels = SEMANTIC_MOODS.filter((mood) => result.m[mood][0] === 'Y');
  if (positiveLabels.length > canonicalSpec.structure.max_positive_labels) {
    return { structuralValid: true, semanticValid: false, code: 'SEMANTIC_CONTRACT_MAX_LABELS', result };
  }
  return { structuralValid: true, semanticValid: true, code: null, result };
}
