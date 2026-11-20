import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareMusicalEvidence, deamSummary, type MusicEvidenceV2 } from '../src/music/musical-evidence-v2.js';

const fixture = (opening: number, ending: number): MusicEvidenceV2 => ({
  trackId: 'id', analysisId: '1', runId: 'run', modelsHash: 'hash', sourceSize: '1', sourceMtimeNs: '2',
  expectedWindows: 2,
  windows: [
    { startMs: 0, endMs: 10000, role: 'opening', outputs: [{
      modelId: 'deam-msd-musicnn-2', label: 'arousal', value: opening,
      nativeScale: 'DEAM native [1,9], valence then arousal', missingReason: null,
    }] },
    { startMs: 20000, endMs: 30000, role: 'ending', outputs: [{
      modelId: 'deam-msd-musicnn-2', label: 'arousal', value: ending,
      nativeScale: 'DEAM native [1,9], valence then arousal', missingReason: null,
    }] },
  ],
});

test('out-of-range DEAM survives as raw evidence but cannot become a 1–9 aggregate', () => {
  const evidence = fixture(3, 11.31);
  const summary = deamSummary(evidence, 'arousal');
  assert.equal(evidence.windows[1].outputs[0].value, 11.31);
  assert.equal(summary.mean, null);
  assert.equal(summary.opening, 3);
  assert.equal(summary.ending, null);
  assert.equal(summary.invalidWindows, 1);
  assert.equal(summary.coverage, 'partial');
});

test('comparison describes direction but Pool delta remains exactly zero', () => {
  const context = { sameShow: true, predecessorReliable: true, request: false };
  const same = compareMusicalEvidence(fixture(5, 5), fixture(5, 5), context);
  const contrast = compareMusicalEvidence(fixture(5, 5), fixture(9, 9), context);
  assert.equal(same.arousalChange, 0);
  assert.equal(contrast.arousalChange, 4);
  assert.equal(same.poolEssentiaDelta, 0);
  assert.equal(contrast.poolEssentiaDelta, 0);
  assert.equal(compareMusicalEvidence(fixture(5, 5), fixture(9, 9), { ...context, sameShow: false }).status, 'unavailable');
  assert.equal(compareMusicalEvidence(fixture(5, 5), fixture(9, 9), { ...context, request: true }).poolEssentiaDelta, 0);
});
