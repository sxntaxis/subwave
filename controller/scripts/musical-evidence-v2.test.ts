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

test('instrument endpoints keep bounded one-sided observations unknown on the other side', () => {
  const output = (label: string, value: number) => ({
    modelId: 'mtg_jamendo_instrument-discogs-effnet-1', label, value,
    validity: 'valid', nativeScale: 'model native; see metadata', missingReason: null,
  });
  const endpoint = (role: 'opening' | 'ending', values: ReturnType<typeof output>[]): MusicEvidenceV2 => {
    const base = fixture(4, 5);
    return { ...base, windows: base.windows.map(w => w.role === role
      ? { ...w, outputs: [...w.outputs, ...values] } : w) };
  };
  const left = endpoint('ending', [output('piano', .4), output('guitar', .2), output('flute', .8)]);
  const right = endpoint('opening', [output('piano', .6), output('guitar', .3), output('drums', .9), output('organ', .7)]);
  const compare = () => compareMusicalEvidence(left, right, { sameShow: true, predecessorReliable: true, request: false }).dimensions!.instruments;
  const result = compare();
  assert.deepEqual(result.labels.map(x => x.label), ['piano', 'guitar', 'drums', 'flute']);
  assert.equal(result.labels[0].change, .6 - .4);
  assert.equal(result.labels[2].predecessor.endpointScore, null);
  assert.equal(result.labels[2].candidate.endpointScore, .9);
  assert.equal(result.labels[3].predecessor.endpointScore, .8);
  assert.equal(result.labels[3].candidate.endpointScore, null);
  assert.equal(result.labels[2].change, null);
  assert.equal(result.labels[3].change, null);
  assert.equal(result.status, 'partial');
  assert.deepEqual(compare(), result);
  const invalidRight = endpoint('opening', [output('piano', .6), output('flute', 1.5)]);
  const invalid = compareMusicalEvidence(left, invalidRight, {
    sameShow: true, predecessorReliable: true, request: false,
  }).dimensions!.instruments;
  const flute = invalid.labels.find(item => item.label === 'flute')!;
  assert.equal(flute.predecessor.endpointScore, .8);
  assert.equal(flute.candidate.endpointScore, null);
  assert.equal(flute.candidate.labelPresent, true);
  assert.equal(flute.change, null);
  const missing = compareMusicalEvidence(left, fixture(4, 5), {
    sameShow: true, predecessorReliable: true, request: false,
  }).dimensions!.instruments;
  assert.equal(missing.candidateHead.headPresent, false);
  assert.ok(missing.labels.every(item => item.change === null && item.candidate.endpointScore === null));
  assert.equal(compareMusicalEvidence(left, { ...right, modelsHash: 'different' }, {
    sameShow: true, predecessorReliable: true, request: false,
  }).dimensions, undefined);
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

test('endpoint comparisons preserve multi-label estimates and unknowns', () => {
  const make = (which: 'left' | 'right'): MusicEvidenceV2 => {
    const base = fixture(4, 5);
    const role = which === 'left' ? 'ending' : 'opening';
    const value = which === 'left' ? .3 : .7;
    return { ...base, windows: base.windows.map(window => window.role !== role ? window : ({
      ...window, outputs: [...window.outputs,
        ...['piano', 'synthesizer'].map((label, i) => ({
          modelId: 'mtg_jamendo_instrument-discogs-effnet-1', label, value: value - i * .1,
          validity: 'valid', nativeScale: 'model native; see metadata', missingReason: null,
        })),
        { modelId: 'voice_instrumental-discogs-effnet-1', label: 'voice', value,
          validity: 'valid', nativeScale: 'model native; see metadata', missingReason: null },
        { modelId: 'timbre-discogs-effnet-1', label: 'bright', value,
          validity: which === 'left' ? 'outside_declared_range' : 'valid',
          nativeScale: 'model native; see metadata', missingReason: null },
      ],
    })) };
  };
  const left = make('left'), right = make('right');
  const comparison = compareMusicalEvidence(left, right,
    { sameShow: true, predecessorReliable: true, request: false });
  const d = comparison.dimensions!;
  assert.deepEqual(d.instruments.labels.map(x => x.label), ['piano', 'synthesizer']);
  assert.ok(Math.abs(d.voice.change! - .4) < 1e-9);
  assert.equal(d.voice.predecessor.validWindows, 1);
  assert.equal(d.voice.predecessor.expectedWindows, 2);
  assert.equal(d.voice.status, 'partial');
  assert.equal(d.instruments.status, 'partial');
  assert.equal(d.timbre.change, null);
  assert.equal(d.timbre.status, 'partial');
  assert.equal(d.arousal.predecessor.expectedWindows, 2);
  assert.equal(d.arousal.candidate.validWindows, 2);
  const invalid = compareMusicalEvidence(fixture(3, 11.31), fixture(4, 5),
    { sameShow: true, predecessorReliable: true, request: false });
  assert.equal(invalid.arousalChange, null);
  assert.equal(invalid.dimensions?.arousal.status, 'partial');
  assert.equal(invalid.dimensions?.arousal.predecessor.endpointScore, null);
  assert.equal(comparison.poolEssentiaDelta, 0);
  assert.equal(compareMusicalEvidence(left, { ...right, modelsHash: 'other' },
    { sameShow: true, predecessorReliable: true, request: false }).dimensions, undefined);
});
