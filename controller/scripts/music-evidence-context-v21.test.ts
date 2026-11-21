import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachCompactMusicEvidence, sampledWindowEvidence,
} from '../src/music/music-evidence-profile.js';
import type { MusicEvidenceV2, ModelOutput } from '../src/music/musical-evidence-v2.js';
import compareMusicalCandidates from '../src/llm/internal/tools/picker/tools/compare-musical-candidates.js';

const DEAM = 'DEAM native [1,9], valence then arousal';
const NATIVE = 'model native; see metadata';
const output = (modelId: string, label: string, value: number | null, validity = 'valid'): ModelOutput => ({
  modelId, label, value, validity, nativeScale: modelId === 'deam-msd-musicnn-2' ? DEAM : NATIVE,
  missingReason: null,
});
function evidence(id: string): MusicEvidenceV2 {
  const windows: MusicEvidenceV2['windows'] = [
    { startMs: 0, endMs: 10000, role: 'opening', outputs: [
      output('deam-msd-musicnn-2', 'arousal', 3),
      output('deam-msd-musicnn-2', 'valence', 4),
      output('voice_instrumental-discogs-effnet-1', 'voice', .2),
      output('timbre-discogs-effnet-1', 'bright', .3),
      output('danceability-discogs-effnet-1', 'danceable', .5),
      ...['piano', 'synthesizer', 'guitar', 'violin', 'flute', 'drums'].map((label, i) =>
        output('mtg_jamendo_instrument-discogs-effnet-1', label, 1 - i * .1)),
      ...['calm', 'happy', 'dark', 'bright', 'epic', 'ambient'].map((label, i) =>
        output('mtg_jamendo_moodtheme-discogs-effnet-1', label, .9 - i * .1)),
    ] },
    { startMs: 120000, endMs: 130000, role: 'ending', outputs: [
      output('deam-msd-musicnn-2', 'arousal', 6),
      output('deam-msd-musicnn-2', 'valence', 5),
      output('voice_instrumental-discogs-effnet-1', 'voice', .4),
      output('timbre-discogs-effnet-1', 'bright', .5),
      output('danceability-discogs-effnet-1', 'danceable', .6),
      ...['piano', 'synthesizer', 'guitar', 'violin', 'flute', 'drums'].map((label, i) =>
        output('mtg_jamendo_instrument-discogs-effnet-1', label, .9 - i * .1)),
      ...['calm', 'happy', 'dark', 'bright', 'epic', 'ambient'].map((label, i) =>
        output('mtg_jamendo_moodtheme-discogs-effnet-1', label, .8 - i * .1)),
    ] },
  ];
  return {
    trackId: id, analysisId: `analysis-${id}`, runId: 'fixture-run', modelsHash: 'a'.repeat(64),
    sourceSize: '1234', sourceMtimeNs: '1700000000000000000', expectedWindows: 2, windows,
  };
}

test('v2.1 discovery fallback covers 12 candidate profiles within the same 8KiB budget', () => {
  const tracks = Array.from({ length: 12 }, (_, i) => ({ id: `fixture-${i}`, title: `Track ${i}` }));
  const rows = new Map(tracks.map(track => [track.id, evidence(track.id)]));
  const before = JSON.stringify(tracks);
  const legacy = attachCompactMusicEvidence(tracks, rows, 8192);
  const rich = attachCompactMusicEvidence(tracks, rows, 8192, { allowBriefFallback: true });
  assert.equal(legacy.tracks.filter(track => track.musical_evidence).length, 0);
  assert.equal(rich.tracks.filter(track => track.musical_evidence).length, 12);
  assert.ok(rich.bytes <= 8192);
  assert.ok(rich.tracks.every(track => track.musical_evidence.detail === 'discovery_brief'));
  assert.ok(rich.tracks.every(track => track.musical_evidence.scoreMeaning === 'native_uncalibrated_model_output'));
  assert.ok(rich.tracks.every(track => !JSON.stringify(track).includes('sourceMtimeNs')));
  assert.equal(JSON.stringify(tracks), before);
});

test('window detail shows native samples, sparse coverage and invalid values honestly', () => {
  const source = evidence('fixture-a');
  const modified: MusicEvidenceV2 = {
    ...source,
    windows: [{ ...source.windows[0], outputs: source.windows[0].outputs.map(o =>
      o.modelId === 'deam-msd-musicnn-2' && o.label === 'arousal' ? { ...o, value: 99, validity: 'outside_declared_range' } : o),
    }, source.windows[1]],
  };
  const detail = sampledWindowEvidence(modified, ['arousal', 'instrument']);
  assert.deepEqual(Object.keys(detail.features), ['arousal', 'instrument']);
  const arousal = detail.features.arousal as any;
  assert.equal(arousal.coverage, 'partial');
  assert.equal(arousal.validWindows, 1);
  assert.equal(arousal.samples[0].value, null);
  assert.equal(arousal.samples[0].validity, 'invalid');
  assert.equal(arousal.samples[1].value, 6);
  const instruments = detail.features.instrument as any;
  assert.equal(instruments.availableLabels, 6);
  assert.equal(instruments.scores.length, 6);
  assert.ok(!JSON.stringify(detail).includes('sourceSize'));
});

test('rich comparison downgrades to the old summary within reservation and flag-off retains legacy shape', async () => {
  const ids = ['candidate-a', 'candidate-b'];
  const rows = new Map(ids.map(id => [id, evidence(id)]));
  const priorFlag = process.env.SUBWAVE_MUSIC_CONTEXT_V21;
  const priorV2 = process.env.SUBWAVE_MUSIC_EVIDENCE_V2;
  process.env.SUBWAVE_MUSIC_EVIDENCE_V2 = '1';
  const build = (reserve: number) => compareMusicalCandidates.build({
    scope: { essentiaDiscovery: true },
    seen: new Map(ids.map(id => [id, { id }])),
    essentia: { lookupV2: async () => rows },
    reserveMusicEvidence: (maxBytes: number) => ({ bytes: Math.min(maxBytes, reserve), release() {} }),
  } as never) as any;
  try {
    process.env.SUBWAVE_MUSIC_CONTEXT_V21 = '1';
    const richTool = build(16 * 1024);
    const full = await richTool.execute({ ids, detail: 'windows', families: ['arousal', 'instrument'] });
    assert.equal(full.status, 'available');
    assert.equal(full.detail, 'windows');
    assert.equal(full.candidates.length, 2);
    assert.ok(full.candidates.every((candidate: any) => candidate.window_evidence));
    const summaryBytes = Buffer.byteLength(JSON.stringify(await richTool.execute({ ids, detail: 'summary' })));
    const detailedBytes = Buffer.byteLength(JSON.stringify(full));
    assert.ok(detailedBytes > summaryBytes);
    const constrained = await build(summaryBytes + 45).execute({ ids, detail: 'windows', families: ['arousal', 'instrument'] });
    assert.equal(constrained.status, 'available');
    assert.equal(constrained.detail, 'summary_budget_fallback');
    process.env.SUBWAVE_MUSIC_CONTEXT_V21 = '0';
    const baseline = await build(16 * 1024).execute({ ids });
    assert.equal(baseline.status, 'available');
    assert.ok(!('detail' in baseline));
    assert.ok(baseline.candidates.every((candidate: any) => !('window_evidence' in candidate)));
  } finally {
    if (priorFlag === undefined) delete process.env.SUBWAVE_MUSIC_CONTEXT_V21;
    else process.env.SUBWAVE_MUSIC_CONTEXT_V21 = priorFlag;
    if (priorV2 === undefined) delete process.env.SUBWAVE_MUSIC_EVIDENCE_V2;
    else process.env.SUBWAVE_MUSIC_EVIDENCE_V2 = priorV2;
  }
});
