import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  CONTRACT_VERSION,
  DECODER_VERSION,
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
  semanticInputSha256,
  semanticRunFingerprint,
  type SemanticRequest,
  type SemanticTrackResult,
} from '../src/music/semantic/contract-v2.js';
import { classifySemantic } from '../src/music/semantic/classify.js';

type CorpusRow = {
  benchmark_row_index: number;
  coyote_track_id: string;
  track: SemanticRequest['tracks'][number];
  evidence_sha256: string;
  semantic_input_sha256: string;
};

const corpusPath = process.env.V121_CORPUS_FULL || '/mnt/Tokyo/Lab/tmp/sxntax/opencode/v121-onecall-work/V121-240-F-CORPUS-FULL.jsonl';
const resultsPath = process.env.V121_RESULTS_PATH || '/mnt/Tokyo/Lab/tmp/sxntax/opencode/v121-onecall-work/V121-ONECALL-RESULTS.jsonl';
const concurrency = 4;
const expectedRows = Number(process.env.V121_EXPECTED_ROWS || 240);

function requestFor(row: CorpusRow): SemanticRequest {
  const inputSha = semanticInputSha256([row.track]);
  if (inputSha !== row.semantic_input_sha256) throw new Error(`CORPUS_INPUT_HASH_MISMATCH:${row.coyote_track_id}`);
  return {
    protocol_version: PROTOCOL_VERSION,
    contract_version: CONTRACT_VERSION,
    batch_id: randomUUID(),
    run_manifest: {
      provider: FROZEN_PROVIDER,
      model: FROZEN_MODEL,
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
        FROZEN_PROVIDER,
        FROZEN_MODEL,
        FROZEN_TEMPERATURE,
        FROZEN_REASONING,
        inputSha,
        SEMANTIC_EXPERIMENT_VERSION,
      ),
      decoder_version: DECODER_VERSION,
      input_material: row.track,
    },
    tracks: [row.track],
  };
}

async function main() {
  const rows = readFileSync(corpusPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as CorpusRow);
  if (rows.length !== expectedRows) throw new Error(`V121_CORPUS_ROWS:${rows.length}`);
  const outputs: any[] = new Array(rows.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= rows.length) return;
      const row = rows[index];
      const startedAt = new Date().toISOString();
      let observed: SemanticTrackResult | null = null;
      try {
        const response = await classifySemantic(requestFor(row), false, { onRawResult: (value) => { observed = value; } });
        outputs[index] = { benchmark_row_index: row.benchmark_row_index, coyote_track_id: row.coyote_track_id, started_at: startedAt, finished_at: new Date().toISOString(), response, raw_semantic_result: observed, error: null };
      } catch (error) {
        outputs[index] = { benchmark_row_index: row.benchmark_row_index, coyote_track_id: row.coyote_track_id, started_at: startedAt, finished_at: new Date().toISOString(), response: null, raw_semantic_result: observed, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  writeFileSync(resultsPath, outputs.map((item) => JSON.stringify(item)).join('\n') + '\n', { encoding: 'utf8' });
  const providerCalls = outputs.reduce((sum, item) => sum + Number(item.response?.provider_calls || 0), 0);
  const errors = outputs.filter((item) => item.error).length;
  appendFileSync(resultsPath + '.summary.json', `${JSON.stringify({ rows: outputs.length, provider_calls: providerCalls, errors, concurrency })}\n`);
  process.stdout.write(`${JSON.stringify({ rows: outputs.length, provider_calls: providerCalls, errors, results: resultsPath })}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
