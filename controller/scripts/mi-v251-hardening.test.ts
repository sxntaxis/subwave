// MI v2.5.1 fabricated offline fixtures — not live musical-quality evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreSelection } from '../src/music/selection-score.js';
import { selectForwardPaths, orderWithForwardPaths, type TrajectoryPath } from '../src/music/trajectory-engine.js';
import { projectVerifiedAirplay, poolVerifiedHistory } from '../src/broadcast/dj-agent/verified-airplay-context.js';
import { verifiedAirplayFacts, verifiedMixerStartFacts } from '../src/broadcast/dj-agent/verified-airplay-facts.js';

const base = {
  enabled:true, sameShow:true, anchorReliable:true,
  predecessor:{ bpm:124 }, recentAired:[], candidate:{ bpm:124 }, baselineRank:2, candidateCount:4,
};
test('coverage-aware scoring reduces lone-BPM influence while old mode is identical', () => {
  const old = scoreSelection(base);
  const oldExplicit = scoreSelection({ ...base, coverageAware:false });
  assert.deepEqual(old, oldExplicit);
  const next = scoreSelection({ ...base, coverageAware:true });
  assert.equal(next.confidence, 0.10);
  assert.equal(next.flow, 1);
  assert.ok(next.utility < old.utility);
  assert.ok(next.utility > next.baseline);
});

test('autonomous contrast reduces continuity weight, only when opted in', () => {
  const regular = scoreSelection({ ...base, coverageAware:true, movementIntent:'hold' });
  const contrast = scoreSelection({ ...base, coverageAware:true, movementIntent:'contrast' });
  assert.ok(contrast.utility < regular.utility);
  const unknown = scoreSelection({ ...base, predecessor:{}, candidate:{}, coverageAware:true,
    movementIntent:'contrast' });
  assert.equal(unknown.utility, unknown.baseline);
});

test('selected paths are canonical and the exact hint path is the ranked path', () => {
  const a: TrajectoryPath = { firstId:'one', possibleSecondId:'two', character:'continuity',
    evidenceDimensions:2, relativeUtility:0.5 };
  const b: TrajectoryPath = { firstId:'one', possibleSecondId:'three', character:'contrast',
    evidenceDimensions:3, relativeUtility:0.7 };
  assert.deepEqual(selectForwardPaths([a,b]), [a]);
  assert.deepEqual(selectForwardPaths([a,b],true), [b]);
  assert.deepEqual(selectForwardPaths([b,a],true), [b]);
  const candidates=[{id:'one'},{id:'two'},{id:'three'}];
  assert.equal(orderWithForwardPaths(candidates,selectForwardPaths([a,b],true)).length,3);
});

test('exact-ID facts: verified fields are canonical, missing is absent, original era wins', () => {
  const facts = verifiedAirplayFacts('s', { title:'old', year:2018, yearUntrusted:true,
    energy:'low', moods:['warm'] }, () => ({ title:'recording', artist:'artist', year:2018,
    originalYear:1971, yearUntrusted:true, energy:'high', moods:['bright'], bpm:124 }));
  assert.equal(facts?.year,1971);
  assert.equal(facts?.energy,'high');
  assert.deepEqual(facts?.moods,['bright']);
  assert.equal(verifiedAirplayFacts(null, {}, () => { throw Error('must not look up'); }),null);
  assert.equal(verifiedAirplayFacts('s', {year:2018,yearUntrusted:true}, () => null)?.year,undefined);
  assert.equal(verifiedMixerStartFacts('s', {id:'unrelated',title:'recording'}, () => {
    throw Error('must not look up'); }), null);
  assert.equal(verifiedMixerStartFacts('s', {id:'s',title:'recording'}, () => ({energy:'high'}))?.energy,'high');
  assert.equal(verifiedMixerStartFacts(null, {id:'s'}, () => {throw Error('must not look up');}), null);
});

const mk = (eventId:string, trackId:string|null, showId:string|null, at:string, artist='artist') => ({
  eventId,trackId,showId,at,artist,energy:null,genre:null,moods:[],
});
test('history uses actual event identity, distinct refs for repeated song, and show scopes', () => {
  const t=new Date('2026-11-22T09:00:00.000Z').toISOString();
  const history=[mk('event-a','same','show',t), mk('event-b','same','show',t),
    mk('event-c','prior','other','2026-11-22T08:00:00.000Z'), mk('event-d',null,'other',t)];
  const out=projectVerifiedAirplay(history,'show',id=>({title:id,artist:'resolved',energy:'high'}));
  assert.deepEqual(out.entries.map(e=>e.historyRef),['H1','H2','H3','H4']);
  assert.deepEqual(out.entries.map(e=>e.showScope),['current','current','previous','previous']);
  assert.equal(out.entries[0].title,'same');
  assert.equal(out.entries[1].title,'same');
  assert.equal(out.entries[3].title,undefined);
  const unknown=projectVerifiedAirplay([mk('unknown',null,null,t)],null);
  assert.equal(unknown.entries[0].showScope,'unknown');
  assert.equal(JSON.stringify(out.entries).includes('event-a'),false);
  assert.equal(poolVerifiedHistory(out,'same',t).currentHistoryRef,'H1');
  assert.equal(poolVerifiedHistory(out,'same',t).recentPlays[0].historyRef,'H2');
});

test('history caps entries and JSON bytes without inventing identity', () => {
  const recent=Array.from({length:20},(_,i)=>mk('e'+i,'id'+i,'show',
    '2026-11-22T09:00:00Z'));
  const out=projectVerifiedAirplay(recent,'show',id=>({title:id,artist:'a'.repeat(99),
    genre:'g'.repeat(170),moods:Array.from({length:8},()=> 'm'.repeat(38))}));
  assert.ok(out.entries.length<=12);
  assert.ok(Buffer.byteLength(JSON.stringify(out.entries),'utf8')<=4096);
  assert.equal(out.details.length,out.entries.length);
});
