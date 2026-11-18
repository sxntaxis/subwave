import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeNavidromeLyrics } from '../src/music/lyrics-display.js';

test('Navidrome line-timed lyrics retain text and apply Subsonic offset', () => {
  const doc = normalizeNavidromeLyrics('song-1', { lyricsList: { structuredLyrics: [{
    synced: true, offset: 200, lang: 'es', line: [
      { start: 2200, value: 'Original line A' },
      { start: 5200, value: 'Original line B' },
    ],
  }] } });
  assert.deepEqual(doc, { id: 'navidrome:song-1', timing: 'line', language: 'es', lines: [
    { id: '0', text: 'Original line A', startMs: 2000 },
    { id: '1', text: 'Original line B', startMs: 5000 },
  ] });
});

test('synced Navidrome variant is preferred over an unsynced translation', () => {
  const doc = normalizeNavidromeLyrics('id', { lyricsList: { structuredLyrics: [
    { synced: false, line: [{ value: 'Untimed text' }] },
    { synced: true, line: [{ start: 0, value: 'Timed text' }] },
  ] } });
  assert.equal(doc?.timing, 'line');
  assert.equal(doc?.lines[0]?.text, 'Timed text');
});

test('malformed timings downgrade to readable plain lyrics, not fake timestamps', () => {
  const doc = normalizeNavidromeLyrics('id', { lyricsList: { structuredLyrics: [{
    synced: true, line: [{ start: 900, value: 'A' }, { value: 'B' }],
  }] } });
  assert.equal(doc?.timing, 'plain');
  assert.deepEqual(doc?.lines, [{ id: '0', text: 'A' }, { id: '1', text: 'B' }]);
});

test('legacy Navidrome lyrics preserve their line breaks', () => {
  assert.deepEqual(normalizeNavidromeLyrics('legacy', { lyrics: { value: 'First\r\nSecond\nThird' } }), {
    id: 'navidrome:legacy', timing: 'plain', lines: [
      { id: '0', text: 'First' }, { id: '1', text: 'Second' }, { id: '2', text: 'Third' },
    ],
  });
});

test('missing lyrics have an explicit null result', () => {
  assert.equal(normalizeNavidromeLyrics('id', {}), null);
});

test('OpenSubsonic v2 uses UTF-8 inclusive byte offsets for real timed segments', () => {
  const doc = normalizeNavidromeLyrics('unicode', { lyricsList: { structuredLyrics: [{
    kind: 'main', synced: true, offset: 100, lang: 'ko',
    line: [{ start: 1100, value: '눈을 뜬' }],
    cueLine: [{ index: 0, start: 1100, end: 2400, value: '눈을 뜬', cue: [
      { start: 1100, end: 1500, value: '눈', byteStart: 0, byteEnd: 2 },
      { start: 1500, end: 1900, value: '을', byteStart: 3, byteEnd: 5 },
      { start: 1950, end: 2300, value: '뜬', byteStart: 7, byteEnd: 9 },
    ] }],
  }] } });
  assert.deepEqual(doc, {
    id: 'navidrome:unicode', timing: 'word', language: 'ko', lines: [{
      id: '0', text: '눈을 뜬', startMs: 1000, endMs: 2300,
      segments: [
        { text: '눈', startMs: 1000, endMs: 1400 },
        { text: '을 ', startMs: 1400, endMs: 1800 },
        { text: '뜬', startMs: 1850, endMs: 2200 },
      ],
    }],
  });
});

test('v2 main agent cues are selected without merging background or translation layers', () => {
  const doc = normalizeNavidromeLyrics('agent', { lyricsList: { structuredLyrics: [
    { kind: 'translation', synced: true, line: [{ start: 1000, value: 'Not primary' }] },
    { kind: 'main', synced: true, line: [{ start: 1000, value: 'Hello world' }],
      agents: [{ id: 'choir', role: 'bg' }, { id: 'lead', role: 'main' }],
      cueLine: [
        { index: 0, agentId: 'choir', value: 'Another voice', cue: [] },
        { index: 0, agentId: 'lead', value: 'Hello world', cue: [
          { start: 1000, end: 1400, value: 'Hello', byteStart: 0, byteEnd: 4 },
          { start: 1400, end: 1800, value: 'world', byteStart: 6, byteEnd: 10 },
        ] },
      ],
    },
  ] } });
  assert.equal(doc?.timing, 'word');
  assert.equal(doc?.lines[0]?.text, 'Hello world');
  assert.deepEqual(doc?.lines[0]?.segments?.map(item => item.text), ['Hello ', 'world']);
});

test('start-only cues downgrade to line timing instead of inventing word ends', () => {
  const doc = normalizeNavidromeLyrics('start-only', { lyricsList: { structuredLyrics: [{
    synced: true, line: [{ start: 500, value: 'Two words' }],
    cueLine: [{ index: 0, value: 'Two words', cue: [
      { start: 500, value: 'Two', byteStart: 0, byteEnd: 2 },
      { start: 900, value: 'words', byteStart: 4, byteEnd: 8 },
    ] }],
  }] } });
  assert.equal(doc?.timing, 'line');
  assert.deepEqual(doc?.lines, [{ id: '0', text: 'Two words', startMs: 500 }]);
});

test('malformed cue offsets or cue text never corrupt line-based lyrics', () => {
  for (const malformed of [
    { start: 500, end: 900, value: 'Bad', byteStart: 0, byteEnd: 2 },
    { start: 500, end: 900, value: 'Good', byteStart: 0, byteEnd: 10 },
    { start: 500, end: 500, value: 'Good', byteStart: 0, byteEnd: 3 },
  ]) {
    const doc = normalizeNavidromeLyrics('bad', { lyricsList: { structuredLyrics: [{
      kind: 'main', synced: true, line: [{ start: 500, value: 'Good' }],
      cueLine: [{ index: 0, value: 'Good', cue: [malformed] }],
    }] } });
    assert.equal(doc?.timing, 'line');
    assert.deepEqual(doc?.lines, [{ id: '0', text: 'Good', startMs: 500 }]);
  }
});

test('independent non-main tracks cannot replace a missing primary transcript', () => {
  const doc = normalizeNavidromeLyrics('no-main', { lyricsList: { structuredLyrics: [{
    kind: 'pronunciation', synced: true, line: [{ start: 100, value: 'Not main' }],
  }] } });
  assert.equal(doc, null);
});

test('preserves explicitly attributed OpenSubsonic v2 backing, duet and independent translation', () => {
  const response = { lyricsList: { structuredLyrics: [
    { kind: 'main', synced: true, lang: 'en', line: [{start:1000,value:'Hi echo'}],
      agents: [{id:'lead',role:'main'}, {id:'choir',role:'bg',name:'Backing'}, {id:'guest',role:'voice'}],
      cueLine: [
        { index:0,agentId:'lead',value:'Hi echo',end:2500,cue: [
          {value:'Hi ',byteStart:0,byteEnd:2,start:1000,end:1500},
          {value:'echo',byteStart:3,byteEnd:6,start:1500,end:2400},
        ]},
        { index:0,agentId:'choir',value:'Hi echo',cue:[
          {value:'echo',byteStart:3,byteEnd:6,start:1800,end:2400},
        ]},
        { index:0,agentId:'guest',value:'Hi echo',cue:[
          {value:'Hi',byteStart:0,byteEnd:1,start:1200,end:1550},
        ]},
      ] },
    { kind:'translation',lang:'es',synced:true,line:[{start:1000,value:'Hola eco'}]},
    { kind:'pronunciation',lang:'en',synced:true,line:[{start:1000,value:'Hai eko'}]},
  ] } };
  const result = normalizeNavidromeLyrics('synthetic',response);
  assert.equal(result?.timing, 'word');
  assert.equal(result?.lines[0]?.vocalLayers?.length, 2);
  assert.equal(result?.lines[0]?.vocalLayers?.[0]?.segments[0]?.text, 'echo');
  assert.equal(result?.alternates?.length,2);
  assert.equal(result?.alternates?.[0]?.lines[0]?.startMs,1000);
});
