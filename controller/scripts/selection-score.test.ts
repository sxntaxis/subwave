import assert from 'node:assert/strict';
import test from 'node:test';
import { acousticSimilarity, medianPace, scoreSelection } from '../src/music/selection-score.js';

const pace = (v: number) => [0, 1, 2].map(i => ({ startMs: i * 1000, endMs: i * 1000 + 1000, value: v }));
const base = { enabled: true, sameShow: true, anchorReliable: true, baselineRank: 1, candidateCount: 3, recentAired: [] };

test('missing evidence is neutral and disabled returns exact baseline', () => {
  const input = { ...base, predecessor: null, candidate: {} };
  assert.equal(scoreSelection(input).utility, 0.5);
  assert.equal(scoreSelection({ ...input, enabled: false, softBoundPlaylistMember: true }).utility, 0.5);
  assert.equal(scoreSelection(input).flow, null);
});

test('pace median requires three finite half-second windows', () => {
  assert.equal(medianPace(pace(0.1)), 0.1);
  assert.equal(medianPace(pace(0.1).slice(0, 2)), null);
  assert.equal(medianPace(pace(0.1).map(s => ({ ...s, endMs: s.startMs + 499 }))), null);
});

test('folded BPM, seam key and pace produce bounded flow', () => {
  const a = { bpm: 70, keyEnd: '8A', pace: pace(0.08), vector: [1, 0] };
  const b = { bpm: 140, keyStart: '8A', pace: pace(0.12), vector: [1, 0] };
  const s = scoreSelection({ ...base, predecessor: a, candidate: b });
  assert.equal(s.bpm, 1);
  assert.equal(s.key, 1);
  assert.ok(Math.abs(s.pace! - Math.exp(-1)) < 1e-10);
  assert.equal(s.clapProximity, 1);
  assert.ok(s.utility >= 0 && s.utility <= 1);
});

test('boundaries and invalid vectors do not fabricate continuity', () => {
  assert.equal(acousticSimilarity([0, 0], [1, 0]), null);
  assert.equal(acousticSimilarity([NaN, 1], [1, 0]), null);
  const s = scoreSelection({ ...base, sameShow: false, predecessor: { bpm: 100 }, candidate: { bpm: 100 } });
  assert.equal(s.flow, null);
  assert.equal(s.utility, 0.5);
});

test('novelty requires at least two valid aired comparisons', () => {
  const c = { vector: [1, 0] };
  assert.equal(scoreSelection({ ...base, predecessor: null, candidate: c, recentAired: [c] }).novelty, null);
  assert.equal(scoreSelection({ ...base, predecessor: null, candidate: c, recentAired: [c, c] }).novelty, 0);
});
