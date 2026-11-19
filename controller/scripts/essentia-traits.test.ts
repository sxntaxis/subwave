import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioProfile, traitScore } from '../src/music/essentia-traits.js';
import { enrichEssentia, getEssentiaReader, withEssentiaReaderForTest } from '../src/music/essentia-evidence.js';
import { flattenToolCalls } from '../src/llm/internal/core/pure.js';

test('profile preserves model scales and omits malformed evidence', () => {
  assert.deepEqual(audioProfile({ arousal: 7.26, valence: 0, voice: 0.734, bright: NaN }), {
    source: 'essentia_estimate', arousal_1_9: 7.3, voice_score: 0.73,
  });
  assert.equal(audioProfile({ arousal: Infinity }), null);
});

test('trait combinations treat missing evidence as unknown, not zero', () => {
  const e = { arousal: 9, voice: 0.2, moods: { calm: 0.6 }, instruments: { piano: 0.4 } };
  assert.equal(traitScore(e, { arousal: 'high', voice: 'instrumental', mood: 'calm', instrument: 'piano' }), 0.7);
  assert.equal(traitScore(e, { valence: 'low', arousal: 'high' }), 1);
  assert.equal(traitScore(e, { instrument: 'saxophone' }), null);
  assert.equal(traitScore({}, {}), null);
});

test('bounded batch enrichment preserves identities and order, and fails open', async () => {
  const tracks = [{ id: 'a', title: 'one' }, { id: 'b', title: 'two' }];
  let calls = 0;
  const reader = {
    async lookup(ids: readonly string[]) {
      calls++;
      assert.deepEqual(ids, ['a', 'b']);
      return new Map([['a', { arousal: 7 }]]);
    },
    async search() { return ['a']; },
  };
  await withEssentiaReaderForTest(reader, async () => {
    assert.equal(getEssentiaReader(), reader);
    const result = await enrichEssentia(getEssentiaReader(), tracks);
    assert.notEqual(result, tracks);
    assert.deepEqual(result.map(t => t.id), ['a', 'b']);
    assert.deepEqual((result[0] as any).audio_profile, { source: 'essentia_estimate', arousal_1_9: 7 });
    assert.equal((result[1] as any).audio_profile, undefined);
    assert.equal((tracks[0] as any).audio_profile, undefined);
  });
  assert.equal(calls, 1);
  assert.equal(getEssentiaReader(), null);
  const original = [{ id: 'c' }];
  assert.equal(await enrichEssentia({ ...reader, lookup: async () => { throw Error('busy'); } }, original), original);
  assert.equal((await enrichEssentia(reader, Array.from({ length: 13 }, (_, i) => ({ id: `${i}` })))).length, 13);
  assert.equal(calls, 1);
});

test('profile additions respect a global byte budget and preserve model provenance', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `track${i}` }));
  const reader = {
    async lookup(ids: readonly string[]) {
      return new Map(ids.map(id => [id, {
        arousal: 6, valence: 3, danceable: 0.8, voice: 0.6, bright: 0.7,
        moods: { melancholic: 0.8 }, instruments: { acousticguitar: 0.7 },
      }]));
    },
    async search() { return []; },
  };
  const result = await enrichEssentia(reader, rows);
  const added = result.reduce((n, item: any) => n + (item.audio_profile
    ? Buffer.byteLength(JSON.stringify({ audio_profile: item.audio_profile })) : 0), 0);
  assert.ok(added <= 2048);
  assert.deepEqual((result[0] as any).audio_profile.mood_model_top, { label: 'melancholic', score: 0.8 });
  assert.deepEqual((result[0] as any).audio_profile.instrument_model_top, { label: 'acousticguitar', score: 0.7 });
  assert.ok(rows.every(row => !('audio_profile' in row)));
});

test('debug and terminal discovery trails omit profiles without changing original tool output', () => {
  const output = { tracks: [{ id: 'fixture', audio_profile: { source: 'essentia_estimate', arousal_1_9: 7 } }] };
  const result = flattenToolCalls({ steps: [{
    toolCalls: [{ toolName: 'findByAudioTraits', input: {} }],
    toolResults: [{ output }],
  }] });
  assert.deepEqual(result[0].result, { tracks: [{ id: 'fixture' }] });
  assert.equal(output.tracks[0].audio_profile.arousal_1_9, 7);
  const ordinary = { tracks: [{ id: 'fixture' }] };
  const unchanged = flattenToolCalls({ steps: [{
    toolCalls: [{ toolName: 'searchLibrary', input: {} }],
    toolResults: [{ output: ordinary }],
  }] });
  assert.equal(unchanged[0].result, ordinary);
});
