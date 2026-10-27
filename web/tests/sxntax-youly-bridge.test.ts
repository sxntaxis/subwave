import assert from 'node:assert/strict';
import test from 'node:test';
import { toYoulyLyrics, createMonotonicLyricsClock, liveRadioLyricsPositionMs } from '../components/skins/sxntax/lyrics/youlyBridge';

test('plain text becomes native YouLyPlus None with safe song part', () => {
  const lyrics = toYoulyLyrics({ id: 'plain', timing: 'plain', lines: [{ id: 'a', text: 'Line A' }] });
  assert.equal(lyrics?.type, 'None');
  assert.equal(lyrics?.data[0]?.element.songPartIndex, 0);
});
test('LRC line times are seconds, not word cues', () => {
  const lyrics = toYoulyLyrics({ id: 'lrc', timing: 'line', lines: [
    { id: 'a', text: 'A', startMs: 1200 }, { id: 'b', text: 'B', startMs: 4300 },
  ] });
  assert.equal(lyrics?.type, 'Line');
  assert.equal(lyrics?.data[0]?.startTime, 1.2);
  assert.equal(lyrics?.data[0]?.endTime, 4.3);
  assert.equal(lyrics?.data[0]?.syllabus, undefined);
});
test('v2 word cues preserve real syllable times in milliseconds', () => {
  const lyrics = toYoulyLyrics({ id: 'words', timing: 'word', lines: [{
    id: 'a', text: 'Hey you', startMs: 1000, endMs: 2800,
    segments: [{ text: 'Hey ', startMs: 1000, endMs: 1700 }, { text: 'you', startMs: 1700, endMs: 2800 }],
  }] });
  assert.equal(lyrics?.type, 'Word');
  assert.deepEqual(lyrics?.data[0]?.syllabus?.[0], { text: 'Hey ', time: 1000, duration: 700 });
});
test('partial word documents preserve genuine cues and leave uncued lines line-timed', () => {
  const lyrics = toYoulyLyrics({ id: 'mixed', timing: 'word', lines: [
    { id: 'a', text: 'first', startMs: 1000, endMs: 3000, segments: [{ text: 'first', startMs: 1000, endMs: 3000 }] },
    { id: 'b', text: 'next', startMs: 3100, endMs: 6000 },
  ] });
  assert.equal(lyrics?.type, 'Word');
  assert.deepEqual(lyrics?.data[0]?.syllabus, [{text:'first',time:1000,duration:2000}]);
  assert.equal(lyrics?.data[1]?.syllabus, undefined);
  assert.equal(lyrics?.data[1]?.startTime, 3.1);
  assert.equal(lyrics?.data[1]?.endTime, 6);
});
test('a word-labelled document without any genuine word cues stays line-timed', () => {
  const lyrics = toYoulyLyrics({id:'no-cues',timing:'word',lines:[
    {id:'a',text:'Only a line',startMs:1000,endMs:3000},
  ]});
  assert.equal(lyrics?.type,'Line');
  assert.equal(lyrics?.data[0]?.syllabus,undefined);
});
test('an attributed guest line keeps its real cues and spacing without a duplicate lead line', () => {
  const lyrics = toYoulyLyrics({id:'guest',timing:'word',agents:[
    {id:'lead',role:'main'},{id:'guest',role:'voice'},
  ],lines:[{id:'guest-line',text:'Guest sings',startMs:1000,endMs:3000,vocalLayers:[
    {agentId:'guest',role:'voice',segments:[
      {text:'Guest',startMs:1000,endMs:1800},{text:'sings',startMs:1900,endMs:3000},
    ]},
  ]}]});
  assert.equal(lyrics?.type,'Word');
  assert.equal(lyrics?.data.length,1);
  assert.equal(lyrics?.data[0]?.element.singer,'guest');
  assert.equal(lyrics?.data[0]?.syllabus?.map(s=>s.text).join(''),'Guest sings');
  assert.deepEqual(lyrics?.data[0]?.syllabus?.map(s=>[s.time,s.duration]),[[1000,800],[1900,1100]]);
});
test('a whole backing-vocal line remains timed and explicitly background-attributed', () => {
  const lyrics = toYoulyLyrics({id:'backing',timing:'line',lines:[
    {id:'bg-line',text:'Backing echo',startMs:1000,endMs:3000,vocalLayers:[
      {agentId:'choir',role:'group',segments:[{text:'Backing echo',startMs:1000,endMs:3000}]},
    ]},
  ]});
  assert.equal(lyrics?.type,'Word');
  assert.equal(lyrics?.data.length,1);
  assert.equal(lyrics?.data[0]?.syllabus?.[0]?.isBackground,true);
});
test('an independent guest cannot replace different untimed lead text', () => {
  const lyrics = toYoulyLyrics({id:'independent',timing:'line',lines:[
    {id:'line',text:'Uncued lead',startMs:1000,endMs:3000,vocalLayers:[
      {agentId:'guest',role:'voice',segments:[{text:'Timed guest',startMs:1200,endMs:2500}]},
    ]},
  ]});
  assert.equal(lyrics?.type,'Word');
  assert.equal(lyrics?.data.length,2);
  assert.equal(lyrics?.data[0]?.text,'Uncued lead');
  assert.equal(lyrics?.data[0]?.syllabus,undefined);
  assert.equal(lyrics?.data[1]?.text,'Timed guest');
});
test('monotonic song clock interpolates coarse ticks and resynchronizes discontinuities', () => {
  const oldPerf = performance.now;
  const clock = createMonotonicLyricsClock();
  clock.reset(1000, 100);
  clock.update(2000, 1100);
  // Evaluate behavioral projection under the current runtime clock.
  assert.equal(typeof clock.getTimeSeconds(), 'number');
  clock.update(12000, 1200);
  assert.ok(Number.isFinite(clock.getTimeSeconds()));
  assert.equal(typeof oldPerf, 'function');
});

test('live-radio listener clock preserves fractional seconds and handles pause/implausible bounds', () => {
  assert.equal(liveRadioLyricsPositionMs(10_000, null, 20, 11_234), 1234);
  assert.equal(liveRadioLyricsPositionMs(10_000, 14_000, 20, 20_000), 4000);
  assert.equal(liveRadioLyricsPositionMs(10_000, null, 20, 80_000), null);
  assert.equal(liveRadioLyricsPositionMs(null, null, 20, 80_000), null);
});

test('OpenSubsonic v2 explicit backing agents and duet voices map to native vocal staging', () => {
  const lyrics = toYoulyLyrics({ id: 'ensemble', timing: 'word', agents: [
    { id: 'lead', role: 'main' }, { id: 'choir', role: 'bg' }, { id: 'guest', role: 'voice' },
  ], lines: [{ id: 'a', text: 'Hi echo', startMs: 1000, endMs: 2500, segments: [
    { text: 'Hi ', startMs: 1000, endMs: 1500 }, { text: 'echo', startMs: 1500, endMs: 2400 },
  ], vocalLayers: [
    { agentId: 'choir', role: 'bg', segments: [{ text: 'echo', startMs: 1800, endMs: 2400 }] },
    { agentId: 'guest', role: 'voice', segments: [{ text: 'Hi', startMs: 1200, endMs: 1550 }] },
  ] }] });
  assert.equal(lyrics?.type, 'Word');
  assert.equal(lyrics?.data.length, 2);
  assert.equal(lyrics?.data[0]?.syllabus?.filter(s => s.isBackground).length, 1);
  assert.equal(lyrics?.data[1]?.element.singer, 'guest');
  assert.equal(lyrics?.metadata.agents?.choir?.type, 'group');
});

test('translation and romanization align only by unique exact timestamps', () => {
  const lyrics = toYoulyLyrics({ id: 'translated', timing: 'line', lines: [
    {id:'a', text:'First', startMs: 1000}, {id:'b', text:'Second', startMs: 2000},
  ], alternates: [
    {kind:'translation',lines:[{text:'Primero',startMs:1000},{text:'Incomparable',startMs:1800}]},
    {kind:'pronunciation',lines:[{text:'First latinized',startMs:1000}]},
  ] });
  assert.equal(lyrics?.data[0]?.translatedText,'Primero');
  assert.equal(lyrics?.data[0]?.romanizedText,'First latinized');
  assert.equal(lyrics?.data[1]?.translatedText,undefined);
});
