import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const CONTRACT_VERSION = "the-lab-moods-v2" as const;
export const SCHEMA_VERSION = "semantic-output-v2" as const;
export const RENDERER_VERSION = "semantic-evidence-renderer-2.1.0" as const;
export const DECODER_VERSION = "semantic-decoder-v2" as const;
export const SEMANTIC_EXPERIMENT_VERSION = 'v1.21' as const;

export const FROZEN_PROVIDER = 'openrouter' as const;
export const FROZEN_MODEL = 'deepseek/deepseek-v4-flash-0731' as const;
export const FROZEN_TEMPERATURE = 0.2 as const;
export const FROZEN_REASONING = 'disabled' as const;

export const SEMANTIC_MOODS = [
  'Serene',
  'Warm',
  'Bright',
  'Playful',
  'Bittersweet',
  'Melancholic',
  'Dark',
  'Tense',
  'Wonder',
] as const;

export const CONTRACT_MATERIAL = "the-lab-moods-v2|Serene,Warm,Bright,Playful,Bittersweet,Melancholic,Dark,Tense,Wonder|judgment=N,U,Y:S,M,W|bittersweet=positive_or_affiliative_warmth+melancholy_or_longing+mixed_valence_gestalt:all-Y|raw-multilabel|decoder=semantic-decoder-v2" as const;
export const SCHEMA_MATERIAL = "semantic-output-v2|track.id:string|min=1|e:S,I|m:exact-nine-moods|judgment:[N]|[U]|[Y,S|M|W]|b:[Y,N,U]^3|raw-multilabel|strict" as const;

export const EXPECTED_PROMPT_STATIC_SHA256 = "51cb3a5426bec242c5d58dcc40f894a5ea187ad5caba207faacaaaaeb5fd3a86" as const;
export const EXPECTED_SCHEMA_SHA256 = "83d7ec4f79b751806e026ca85d7d7da612b906b58d8a4ef1a721b445e23759ce" as const;
export const EXPECTED_CONTRACT_SHA256 = "698eaf98859a3d4d24136976b0b03db972fb572bd178740baf92ed364bbe534c" as const;
export const EXPECTED_RENDERER_SHA256 = "8afdeb9b68c0a08bba28ff31b029122cdb4a41946c5445fc9fe39d5dad6308eb" as const;

const JudgmentSchema = z.union([
  z.tuple([z.literal('N')]),
  z.tuple([z.literal('U')]),
  z.tuple([z.literal('Y'), z.enum(['S', 'M', 'W'])]),
]);

const B_VALUE_SCHEMA = z.enum(['Y', 'N', 'U']).describe('Exactly one of "Y", "N", or "U".');
const B_SCHEMA_DESCRIPTION = 'Ordered JSON array, never an object, with exactly 3 elements: position 0 = WARMTH_AFFILIATION (positive / affiliative warmth); position 1 = MELANCHOLY_LONGING (melancholy / longing); position 2 = MIXED_VALENCE_COEXISTENCE (salient simultaneous coexistence of positive and negative valence). Preserve this exact order. Each element must be exactly "Y", "N", or "U"; object-form b is invalid.';

export const SemanticTrackResultSchema = z.object({
  id: z.string().min(1),
  e: z.enum(['S', 'I']),
  m: z.object({
    Serene: JudgmentSchema,
    Warm: JudgmentSchema,
    Bright: JudgmentSchema,
    Playful: JudgmentSchema,
    Bittersweet: JudgmentSchema,
    Melancholic: JudgmentSchema,
    Dark: JudgmentSchema,
    Tense: JudgmentSchema,
    Wonder: JudgmentSchema,
  }).strict(),
  b: z.tuple([B_VALUE_SCHEMA, B_VALUE_SCHEMA, B_VALUE_SCHEMA])
     .rest(z.never())
     .describe(B_SCHEMA_DESCRIPTION)
     .meta({ title: B_SCHEMA_DESCRIPTION }),
}).strict();

export const SemanticInputTrackSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  year: z.union([z.string(), z.number(), z.null()]),
  genres: z.array(z.unknown()).max(20),
  evidence: z.string().max(6000),
}).strict();

export const SemanticRunManifestSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoning: z.string().min(1),
  temperature: z.number(),
  semantic_experiment_version: z.literal(SEMANTIC_EXPERIMENT_VERSION),
  prompt_version: z.string().length(64),
  schema_version: z.string().min(1),
  renderer_version: z.string().min(1),
  prompt_static_sha256: z.string().length(64),
  schema_sha256: z.string().length(64),
  contract_sha256: z.string().length(64),
  renderer_sha256: z.string().length(64),
  semantic_input_sha256: z.string().length(64),
  semantic_run_fingerprint: z.string().length(64),
  decoder_version: z.string().min(1),
  input_material: z.unknown(),
}).strict();

export const SemanticRequestSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  contract_version: z.literal(CONTRACT_VERSION),
  batch_id: z.string().min(1),
  run_manifest: SemanticRunManifestSchema,
  // Coyote v1 invokes semantic inference one track at a time. Keeping this
  // exact makes cost, provenance and timeout semantics explicit.
  tracks: z.array(SemanticInputTrackSchema).length(1),
}).strict();

export type SemanticTrackResult = z.infer<typeof SemanticTrackResultSchema>;
export type SemanticInputTrack = z.infer<typeof SemanticInputTrackSchema>;
export type SemanticRequest = z.infer<typeof SemanticRequestSchema>;

export interface SemanticResponse {
  protocol_version: typeof PROTOCOL_VERSION;
  contract_version: typeof CONTRACT_VERSION;
  batch_id: string;
  provider: string;
  model: string;
  actual_provider: string;
  actual_model: string;
  actual_temperature: number;
  actual_reasoning: string;
  structural_schema_valid: boolean;
  semantic_contract_valid: boolean;
  semantic_outcome: string;
  schema_version: typeof SCHEMA_VERSION;
  renderer_version: typeof RENDERER_VERSION;
  prompt_static_sha256: string;
  schema_sha256: string;
  contract_sha256: string;
  renderer_sha256: string;
  semantic_input_sha256: string;
  semantic_run_fingerprint: string;
  results: SemanticTrackResult[];
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('SCHEMA_FAILURE: unsupported JSON value');
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

export function semanticInputSha256(tracks: SemanticInputTrack[]): string {
  return sha256Text(stableJson(tracks));
}

export function semanticRunFingerprint(
  provider: string,
  model: string,
  temperature: number,
  reasoning: string,
  inputSha256: string,
  semanticExperimentVersion: string,
): string {
  const material = {
    semantic_input_sha256: inputSha256,
    provider,
    model,
    temperature,
    reasoning,
    semantic_experiment_version: semanticExperimentVersion,
    contract_sha256: EXPECTED_CONTRACT_SHA256,
    prompt_static_sha256: EXPECTED_PROMPT_STATIC_SHA256,
    schema_sha256: EXPECTED_SCHEMA_SHA256,
    renderer_version: RENDERER_VERSION,
    renderer_sha256: EXPECTED_RENDERER_SHA256,
    decoder_version: DECODER_VERSION,
    schema_version: SCHEMA_VERSION,
  };
  return sha256Text(stableJson(material));
}

export function validateFrozenRequest(request: SemanticRequest, mock: boolean): void {
  const expectedProvider = mock ? 'mock' : FROZEN_PROVIDER;
  const expectedModel = mock ? 'mock-semantic-v1' : FROZEN_MODEL;
  const manifest = request.run_manifest;

  if (
    manifest.provider !== expectedProvider
    || manifest.model !== expectedModel
    || manifest.temperature !== FROZEN_TEMPERATURE
    || manifest.reasoning !== FROZEN_REASONING
  ) {
    throw new Error(
      `PROVIDER_PINNING_UNAVAILABLE: expected ${expectedProvider}:${expectedModel} `
      + `temperature=${FROZEN_TEMPERATURE} reasoning=${FROZEN_REASONING}`,
    );
  }

  if (manifest.semantic_experiment_version !== SEMANTIC_EXPERIMENT_VERSION) {
    throw new Error('PROVENANCE_FAILURE: semantic version mismatch');
  }

  if (
    manifest.schema_version !== SCHEMA_VERSION
    || manifest.renderer_version !== RENDERER_VERSION
    || manifest.decoder_version !== DECODER_VERSION
  ) {
    throw new Error('PROVENANCE_FAILURE: semantic version mismatch');
  }

  const staticChecks: Array<[string, string, string]> = [
    ['prompt_static_sha256', manifest.prompt_static_sha256, EXPECTED_PROMPT_STATIC_SHA256],
    ['prompt_version', manifest.prompt_version, EXPECTED_PROMPT_STATIC_SHA256],
    ['schema_sha256', manifest.schema_sha256, EXPECTED_SCHEMA_SHA256],
    ['contract_sha256', manifest.contract_sha256, EXPECTED_CONTRACT_SHA256],
    ['renderer_sha256', manifest.renderer_sha256, EXPECTED_RENDERER_SHA256],
  ];
  for (const [name, actual, expected] of staticChecks) {
    if (actual !== expected) throw new Error(`PROVENANCE_FAILURE: ${name}`);
  }

  if (stableJson(manifest.input_material) !== stableJson(request.tracks[0])) {
    throw new Error('PROVENANCE_FAILURE: input_material');
  }

  const inputSha256 = semanticInputSha256(request.tracks);
  if (manifest.semantic_input_sha256 !== inputSha256) {
    throw new Error('PROVENANCE_FAILURE: semantic_input_sha256');
  }

  const fingerprint = semanticRunFingerprint(
    manifest.provider,
    manifest.model,
    manifest.temperature,
    manifest.reasoning,
    inputSha256,
    manifest.semantic_experiment_version,
  );
  if (manifest.semantic_run_fingerprint !== fingerprint) {
    throw new Error('PROVENANCE_FAILURE: semantic_run_fingerprint');
  }
}
