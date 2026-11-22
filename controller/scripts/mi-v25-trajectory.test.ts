import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sonicPoint, measureTrajectory, evaluateForwardPaths, orderWithForwardPaths,
  type SonicPoint, type AiredSonicPoint,
} from '../src/music/trajectory-engine.js';
import { pointFromDiscovery } from '../src/music/trajectory-rank.js';
import { searchEligibleCohort } from '../src/music/music-evidence-cohort.js';
import type { MusicEvidenceV2 } from '../src/music/musical-evidence-v2.js';

const row = (id: string, a: number, v: number, d: number, complete = true): MusicEvidenceV2 => ({
  trackId: id, analysisId: 'fixture', runId: 'fixture', modelsHash: 'fixture',
  sourceSize: '1', sourceMtimeNs: '1', expectedWindows: 3,
  windows: (complete ? ['opening','body','ending'] : ['opening','body']).map((role, i) => ({
    startMs: i * 1000, endMs: i * 1000 + 800,
    role: role as 'opening' | 'body' | 'ending',
    outputs: [
      { modelId: 'deam-msd-musicnn-2', label: 'arousal', value: a,
        nativeScale: 'DEAM native [1,9], valence then arousal', missingReason: null, validity: 'valid' },
      { modelId: 'deam-msd-musicnn-2', label: 'valence', value: v,
        nativeScale: 'DEAM native [1,9], valence then arousal', missingReason: null, validity: 'valid' },
      { modelId: 'danceability-discogs-effnet-1', label: 'danceable', value: d,
        nativeScale: 'model native; see metadata', missingReason: null, validity: 'valid' },
    ],
  })),
});
const point = (id: string, eventId: string, a: number): AiredSonicPoint =>
  ({ id, eventId, arousal: a, valence: 0.5, danceability: 0.5 });

test('complete native sample windows produce normalized measured dimensions', () => {
  const result = sonicPoint(row('a', 5, 7, 0.3));
  assert.deepEqual(result, { arousal: 0.5, valence: 0.75, danceability: 0.3 });
  assert.equal(sonicPoint(row('b', 5, 7, 0.3, false)), null);
});

test('discovery projection refuses partial heads and out-of-range values', () => {
  assert.deepEqual(pointFromDiscovery({ id: 'x', musical_evidence: {
    arousal: { coverage: 'partial', mean: 8 }, valence: { coverage: 'complete', mean: 17 },
    danceable: { status: 'complete', score: 2 },
  } }), { arousal: null, valence: null, danceability: null });
});

test('measured trajectory is from actual complete starts, not verbal destination', () => {
  const history = [point('c','e3',0.8), point('b','e2',0.5), point('a','e1',0.3)];
  const rising = measureTrajectory(history, 'build');
  assert.equal(rising.status, 'measured');
  assert.deepEqual(rising.arousal, { latest: 0.8, change: 0.5, alignment: 'aligned' });
  assert.equal(measureTrajectory(history, 'release').arousal?.alignment, 'diverging');
  assert.equal(measureTrajectory(history, null).arousal?.alignment, 'level');
});

test('missing readings do not imply success or stagnation', () => {
  const history = [point('c','e3',0.8), { ...point('b','e2',0.5), arousal: null },
    point('a','e1',0.3)];
  const report = measureTrajectory(history, 'build');
  assert.equal(report.status, 'insufficient');
  assert.equal(report.arousal, null);
  assert.match(report.note, /Insufficient/);
  assert.equal(measureTrajectory([point('a','e1',0.2), point('b','e1',0.9)], 'build').observed, 1);
});

test('look-ahead makes two contrasting feasible proposals only from supplied IDs', () => {
  const predecessor: SonicPoint = { arousal: 0.35, valence: 0.6, danceability: 0.4 };
  const list = [
    { id:'a', artist:'one', arousal:0.4, valence:0.65, danceability:0.41 },
    { id:'b', artist:'two', arousal:0.55, valence:0.67, danceability:0.51 },
    { id:'c', artist:'three', arousal:0.85, valence:0.20, danceability:0.7 },
    { id:'d', artist:'four', arousal:0.12, valence:0.1, danceability:0.8 },
  ];
  const paths = evaluateForwardPaths(list, predecessor, 'build');
  assert.equal(paths.length, 2);
  assert.deepEqual(paths.map(p => p.character), ['continuity','contrast']);
  for (const path of paths) {
    assert.ok(list.some(x => x.id === path.firstId));
    assert.ok(list.some(x => x.id === path.possibleSecondId));
    assert.notEqual(path.firstId, path.possibleSecondId);
    assert.ok(path.evidenceDimensions >= 2);
  }
});

test('sparse or unknown predecessor cannot manufacture future paths', () => {
  const few = [{id:'a',arousal:0.2,valence:null,danceability:null},
    {id:'b',arousal:0.4,valence:null,danceability:null},
    {id:'c',arousal:0.9,valence:null,danceability:null}];
  assert.deepEqual(evaluateForwardPaths(few, {arousal:0.5,valence:null,danceability:null}, 'build'), []);
  assert.deepEqual(evaluateForwardPaths(few, null, 'build'), []);
});

test('soft rank conserves membership, baseline and stable ties', () => {
  const items = Array.from({length:12},(_,i)=>({id:String(i)}));
  const paths = [{ firstId:'11', possibleSecondId:'10', character:'contrast' as const,
    evidenceDimensions:3, relativeUtility:2 }];
  const ranked = orderWithForwardPaths(items, paths);
  assert.deepEqual(new Set(ranked.map(x=>x.id)), new Set(items.map(x=>x.id)));
  assert.equal(ranked.length, items.length);
  assert.deepEqual(orderWithForwardPaths(items, [], 0.12), items);
  assert.deepEqual(orderWithForwardPaths(items, paths, 0), items);
});

test('eligible indexed search never accepts off-cohort IDs', async () => {
  const called: string[][] = [];
  const search = async (request: { eligibleIds: string[] }) => {
    called.push(request.eligibleIds);
    return { results: [{id:'outside',tier:'full' as const,score:0.9,
      evidenceCoverage:1, matchedPreferences:1, requestedPreferences:1}],
      rankedCount:1,rejectedFreshness:0 };
  };
  const result = await searchEligibleCohort(['a','b'],
    [{family:'arousal',key:'value',direction:'high'}], search, performance.now()+1000);
  assert.deepEqual(result, {status:'incomplete',reason:'invalid_result'});
  assert.deepEqual(called, [['a','b']]);
});

test('cohort search reports verification-limited rather than silently claiming no music', async () => {
  const result = await searchEligibleCohort(['a','b'],
    [{family:'arousal',key:'value',direction:'low'}],
    async () => ({results:[],rankedCount:2,rejectedFreshness:0,verificationLimited:true}),
    performance.now()+1000);
  assert.deepEqual(result, {status:'incomplete',reason:'verification_limited'});
});

test('cohort probe splits bounded eligible IDs without broadening selection', async () => {
  const ids = Array.from({ length: 65 }, (_, i) => `song-${i}`);
  const called: string[][] = [];
  const result = await searchEligibleCohort(ids,
    [{ family:'arousal', key:'value', direction:'high' }], async request => {
      called.push(request.eligibleIds);
      return { results: [{ id: request.eligibleIds[0], tier:'full' as const,
        score: 0.7, evidenceCoverage:1, matchedPreferences:1, requestedPreferences:1 }],
        rankedCount: request.eligibleIds.length, rejectedFreshness:0 };
    }, performance.now() + 1000);
  assert.equal(result.status, 'complete');
  assert.equal(called.length, 1); // 65 IDs fit the protected 128-ID/32KiB envelope
  assert.equal(called[0].length, 65);
  if (result.status === 'complete') assert.ok(result.results.every(r => ids.includes(r.id)));
});

test('no cross-show inference: a missing current-movement cohort is insufficient', () => {
  const oldShow = [point('a','old-1',0.2), point('b','old-2',0.5), point('c','old-3',0.8)];
  const activeMovementOnly = oldShow.slice(2);
  assert.equal(measureTrajectory(activeMovementOnly, 'build').status, 'insufficient');
});

test('conservative rank never adds a speculative second choice to the returned list', () => {
  const options = [{firstId:'a',possibleSecondId:'missing',character:'contrast' as const,
    relativeUtility:2,evidenceDimensions:3}];
  const list = [{id:'a'}, {id:'b'}, {id:'c'}];
  assert.deepEqual(new Set(orderWithForwardPaths(list, options).map(x=>x.id)),
    new Set(['a','b','c']));
});

test('look-ahead does not treat same-artist duplicates as a second distinct movement', () => {
  const pred = {arousal:0.4,valence:0.4,danceability:0.4};
  const list = [
    {id:'a',artist:'same',arousal:0.3,valence:0.3,danceability:0.3},
    {id:'b',artist:'same',arousal:0.7,valence:0.7,danceability:0.7},
    {id:'c',artist:'same',arousal:0.6,valence:0.6,danceability:0.6},
  ];
  assert.deepEqual(evaluateForwardPaths(list,pred,'build'), []);
});
