import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactMusicEvidence } from '../src/music/music-evidence-profile.js';
import type { MusicEvidenceV2, ModelOutput } from '../src/music/musical-evidence-v2.js';

test('compact profile keeps multiple estimates and reports sparse invalid evidence honestly', () => {
  const output = (modelId: string, label: string, value: number, validity = 'valid'): ModelOutput => ({
    modelId, label, value, validity, nativeScale: 'model native; see metadata', missingReason: null,
  });
  const windows: MusicEvidenceV2['windows'] = [
    { startMs: 0, endMs: 10000, role: 'opening', outputs: [
      output('mtg_jamendo_instrument-discogs-effnet-1', 'piano', .8),
      output('mtg_jamendo_instrument-discogs-effnet-1', 'synthesizer', .7),
      output('mtg_jamendo_moodtheme-discogs-effnet-1', 'calm', .6),
      { modelId: 'deam-msd-musicnn-2', label: 'arousal', value: 11.31,
        nativeScale: 'DEAM native [1,9], valence then arousal', missingReason: null, validity: 'outside_declared_range' },
    ] },
    { startMs: 10000, endMs: 20000, role: 'ending', outputs: [
      output('mtg_jamendo_instrument-discogs-effnet-1', 'piano', .6),
      output('mtg_jamendo_instrument-discogs-effnet-1', 'synthesizer', .5),
      output('mtg_jamendo_moodtheme-discogs-effnet-1', 'calm', .4),
      { modelId: 'deam-msd-musicnn-2', label: 'arousal', value: 4,
        nativeScale: 'DEAM native [1,9], valence then arousal', missingReason: null, validity: 'valid' },
    ] },
  ];
  const profile = compactMusicEvidence({
    trackId: 'id', analysisId: '1', runId: 'r', modelsHash: 'hash', sourceSize: '1',
    sourceMtimeNs: '2', expectedWindows: 2, windows,
  });
  assert.deepEqual(profile.instruments.scores, [{ label: 'piano', score: .7 }, { label: 'synthesizer', score: .6 }]);
  assert.deepEqual(profile.moodThemes.scores, [{ label: 'calm', score: .5 }]);
  assert.equal(profile.arousal.coverage, 'partial');
  assert.equal(profile.arousal.mean, null);
  assert.equal(profile.arousal.opening, null);
  assert.equal(profile.windowSampling, 'sparse_windows_not_continuous');
  assert.equal(profile.voice.status, 'unavailable');
});
