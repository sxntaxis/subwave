/**
 * Deterministic offline byte probe for the existing picker evidence serializers.
 *
 * Run from controller/ with the repository's existing dependencies:
 *   ./node_modules/.bin/tsx scripts/music-evidence-context-probe.ts
 *
 * All IDs and payload values below are synthetic and explicitly labeled. No
 * service, database, audio, provider, model, or network access is performed.
 */
import { attachCompactMusicEvidence, compactMusicEvidence } from '../src/music/music-evidence-profile.js';
import type { EvidenceWindow, ModelOutput, MusicEvidenceV2 } from '../src/music/musical-evidence-v2.js';
import compareMusicalCandidates from '../src/llm/internal/tools/picker/tools/compare-musical-candidates.js';

const MODEL = {
  deam: 'deam-msd-musicnn-2',
  instrument: 'mtg_jamendo_instrument-discogs-effnet-1',
  mood: 'mtg_jamendo_moodtheme-discogs-effnet-1',
  dance: 'danceability-discogs-effnet-1',
  voice: 'voice_instrumental-discogs-effnet-1',
  timbre: 'timbre-discogs-effnet-1',
} as const;
const UNIT = 'model native; see metadata';
const DEAM = 'DEAM native [1,9], valence then arousal';
const MODELS_HASH = 'a'.repeat(64);
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

function output(modelId: string, label: string, value: number | null, opts: Partial<ModelOutput> = {}): ModelOutput {
  return {
    modelId, label, value, nativeScale: modelId === MODEL.deam ? DEAM : UNIT,
    missingReason: null, validity: value == null ? 'invalid_number' : 'valid', ...opts,
  };
}

function evidence(id: string, quality: 'full' | 'partial' | 'sparse', cardinality: number): MusicEvidenceV2 {
  const labels = Array.from({ length: cardinality }, (_, i) => `label${String(i).padStart(2, '0')}`);
  const windows: EvidenceWindow[] = ['opening', 'body', 'ending'].map((role, windowIndex) => {
    const outputs: ModelOutput[] = [];
    const include = quality === 'full' || (quality === 'partial' && windowIndex < 2)
      || (quality === 'sparse' && windowIndex === 1);
    if (include) {
      outputs.push(output(MODEL.deam, 'arousal', quality === 'sparse' ? 99 : 3 + windowIndex));
      outputs.push(output(MODEL.deam, 'valence', quality === 'sparse' ? null : 4 + windowIndex,
        quality === 'sparse' ? { validity: 'outside_declared_range', missingReason: null } : {}));
      outputs.push(output(MODEL.dance, 'danceable', quality === 'sparse' ? null : 0.2 + windowIndex * 0.1,
        quality === 'sparse' ? { validity: 'source_missing', missingReason: 'not emitted' } : {}));
      outputs.push(output(MODEL.voice, 'voice', 0.4 + windowIndex * 0.1));
      outputs.push(output(MODEL.timbre, 'bright', 0.6 - windowIndex * 0.1));
      for (const [i, label] of labels.entries()) {
        outputs.push(output(MODEL.instrument, label, quality === 'sparse' ? null : 0.95 - i * 0.02,
          quality === 'sparse' ? { validity: 'invalid_number' } : {}));
        outputs.push(output(MODEL.mood, label, quality === 'sparse' ? null : 0.85 - i * 0.015,
          quality === 'sparse' ? { validity: 'invalid_number' } : {}));
      }
    }
    return { startMs: windowIndex * 30_000, endMs: windowIndex * 30_000 + 10_000,
      role: role as EvidenceWindow['role'], outputs };
  });
  return {
    trackId: id, analysisId: `synthetic-analysis-${id}`, runId: 'synthetic-run',
    modelsHash: MODELS_HASH, sourceSize: '123456', sourceMtimeNs: '1700000000000000000',
    expectedWindows: 3, windows,
  };
}

function discoveryCase(count: number, quality: 'full' | 'partial' | 'sparse') {
  const tracks = Array.from({ length: count }, (_, i) => ({
    id: `synthetic-${quality}-${count}-${i}`,
    title: `Synthetic labeled fixture track ${i}`,
    artist: `Fixture artist ${i % 3}`,
    album: 'Offline probe only',
  }));
  const rows = new Map<string, MusicEvidenceV2>();
  const before = new Map<string, {
    instrumentLabels: number; moodLabels: number; completeInstrumentLabels: number; completeMoodLabels: number;
  }>();
  tracks.forEach((track, i) => {
    const cardinality = [0, 2, 4, 8, 12][i % 5];
    const row = evidence(track.id, quality, cardinality);
    rows.set(track.id, row);
    const compact = compactMusicEvidence(row);
    before.set(track.id, {
      instrumentLabels: compact.instruments.scores.length,
      moodLabels: compact.moodThemes.scores.length,
      completeInstrumentLabels: quality === 'full' ? cardinality : 0,
      completeMoodLabels: quality === 'full' ? cardinality : 0,
    });
  });
  const attached = attachCompactMusicEvidence(tracks, rows, 8192);
  let instrumentLabelsDroppedByShare = 0;
  let moodLabelsDroppedByShare = 0;
  let instrumentLabelsDroppedByTopFour = 0;
  let moodLabelsDroppedByTopFour = 0;
  let omittedProfiles = 0;
  for (const track of attached.tracks) {
    const prior = before.get(track.id)!;
    instrumentLabelsDroppedByTopFour += Math.max(0, prior.completeInstrumentLabels - prior.instrumentLabels);
    moodLabelsDroppedByTopFour += Math.max(0, prior.completeMoodLabels - prior.moodLabels);
    const profile = track.musical_evidence;
    if (!profile) {
      omittedProfiles++;
      continue;
    }
    instrumentLabelsDroppedByShare += Math.max(0, prior.instrumentLabels - profile.instruments.scores.length);
    moodLabelsDroppedByShare += Math.max(0, prior.moodLabels - profile.moodThemes.scores.length);
  }
  return {
    discoveryResults: count,
    evidenceShape: quality,
    jsonUtf8Bytes: bytes(attached.tracks),
    evidenceBytes: attached.bytes,
    songsWithEvidence: attached.tracks.filter(track => !!track.musical_evidence).length,
    instrumentLabelsDroppedByShare,
    moodLabelsDroppedByShare,
    instrumentLabelsDroppedByTopFour,
    moodLabelsDroppedByTopFour,
    profilesOmittedByShare: omittedProfiles,
  };
}

async function comparisonCase(count: 2 | 4, quality: 'full' | 'partial' | 'sparse', reservationBytes: number) {
  const ids = Array.from({ length: count }, (_, i) => `synthetic-compare-${quality}-${count}-${i}`);
  const predecessorId = 'synthetic-predecessor';
  const rows = new Map<string, MusicEvidenceV2>();
  rows.set(predecessorId, evidence(predecessorId, quality, 8));
  ids.forEach((id, i) => rows.set(id, evidence(id, quality, [2, 8, 12, 4][i])));
  const events: unknown[] = [];
  const ctx = {
    scope: {
      selection: { predecessorId },
      essentiaAudit: { noteV2Compare() {}, captureV2Comparison(event: unknown) { events.push(event); } },
    },
    seen: new Map(ids.map(id => [id, { id }])),
    essentia: { lookupV2: async (lookupIds: string[]) => new Map(lookupIds.flatMap(id => {
      const row = rows.get(id);
      return row ? [[id, row] as const] : [];
    })) },
    reserveMusicEvidence(maxBytes: number) {
      if (reservationBytes <= 0) return null;
      const reserved = Math.min(maxBytes, reservationBytes);
      return { bytes: reserved, release() {} };
    },
  };
  const tool = compareMusicalCandidates.build(ctx as never) as unknown as {
    execute: (input: { ids: string[] }) => Promise<unknown>;
  };
  const result = await tool.execute({ ids });
  const resultStatus = (result as { status?: string }).status ?? 'unknown';
  return {
    comparisonIds: count,
    evidenceShape: quality,
    reservationBytes,
    resultStatus,
    jsonUtf8Bytes: bytes(result),
    unavailableDueToEnvelopeBudget: resultStatus === 'unavailable'
      && (result as { note?: string }).note === 'Comparison exceeds the remaining evidence budget.',
    actualToolAuditOutcomes: events,
  };
}

async function main() {
  const discovery = (['full', 'partial', 'sparse'] as const)
    .flatMap(quality => [2, 4, 8, 12].map(count => discoveryCase(count, quality)));
  const comparisons = [];
  for (const quality of ['full', 'partial', 'sparse'] as const) {
    for (const count of [2, 4] as const) {
      comparisons.push(await comparisonCase(count, quality, 16 * 1024));
    }
  }
  comparisons.push(await comparisonCase(4, 'full', 1024));
  console.log(JSON.stringify({
    label: 'synthetic fixture measurement; UTF-8 JSON bytes, not token estimates',
    discovery,
    comparison: comparisons,
  }, null, 2));
}

void main();
