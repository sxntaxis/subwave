import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPickerContext, pickerScope } from '../src/llm/internal/tools/picker/scope.js';
import playlistTool from '../src/llm/internal/tools/picker/tools/show-playlist-tracks.js';
import type { IndexedAcousticRow } from '../src/music/library-db/acoustic-index.js';

const songs = Array.from({ length: 18 }, (_, i) => ({
  id: `id${i}`, title: `Song ${i}`, artist: `Artist ${i}`, duration: 180,
}));
const selection = { predecessorId: 'anchor', recentAiredIds: [] };
const pace = (value: number) => JSON.stringify(Array.from({ length: 3 }, (_, i) =>
  ({ startMs: i * 1000, endMs: (i + 1) * 1000, value })));
const row = (id: string, good: boolean): IndexedAcousticRow => ({
  id, track: { bpm: good ? 80 : 133, musical_key: good ? '8A' : '2B',
    pace_json: pace(good ? 0.1 : 0.9), key_ranges_json: null, duration_sec: 180 },
  vector: new Float32Array(good ? [1, 0] : [-1, 0]),
});
const read = async (ids: readonly string[]) => ids.map(id =>
  row(id, id === 'anchor' || Number(id.slice(2)) >= 12));

async function run(enabled: boolean, acoustic = read) {
  const seen = new Map<string, any>();
  const scope = pickerScope({ seen, playlistTracks: songs, ...(enabled ? { selection } : {}) });
  const ctx = buildPickerContext(scope, acoustic);
  const tool = playlistTool.build(ctx) as any;
  const oldRandom = Math.random;
  let draw = 0;
  Math.random = () => 1 - (draw++ / 100);
  try {
    const result = await tool.execute({}, { toolCallId: 'test', messages: [] });
    return { ids: result.map((x: any) => x.id), seen, draws: draw };
  } finally { Math.random = oldRandom; }
}

test('real playlist tool scores before its twelve-track cap; OFF keeps baseline RNG and mapping', async () => {
  const off = await run(false);
  const on = await run(true);
  assert.equal(off.ids.length, 12);
  assert.equal(on.ids.length, 12);
  assert.deepEqual(off.ids, songs.slice(0, 12).map(s => s.id));
  assert.ok(on.ids.some(id => Number(id.slice(2)) >= 12));
  assert.equal(off.draws, 18);
  assert.equal(on.draws, off.draws);
  assert.deepEqual([...on.seen.keys()], on.ids);
});

test('cold and failed evidence preserve exactly the same shuffled baseline', async () => {
  const off = await run(false);
  const cold = await run(true, async () => null as any);
  const failed = await run(true, async () => { throw new Error('index unavailable'); });
  assert.deepEqual(cold.ids, off.ids);
  assert.deepEqual(failed.ids, off.ids);
  const missing = await run(true, async ids => ids.map(id => ({ id, track: null, vector: null })));
  assert.deepEqual(missing.ids, off.ids);
});

test('rhythmic and atmospheric evidence independently change the pre-cap sample', async () => {
  const off = await run(false);
  for (const mode of ['rhythmic', 'atmospheric'] as const) {
    const reader = async (ids: readonly string[]) => ids.map(id => {
      const good = id === 'anchor' || Number(id.slice(2)) >= 12;
      const result = row(id, good);
      if (mode === 'rhythmic') {
        result.vector = null;
        result.track!.musical_key = null;
      } else {
        result.track!.bpm = null;
        result.track!.musical_key = null;
        result.track!.pace_json = null;
      }
      return result;
    });
    const on = await run(true, reader);
    assert.notDeepEqual(on.ids, off.ids, mode);
    assert.ok(on.ids.some(id => Number(id.slice(2)) >= 12), mode);
  }
});

test('async eligibility enforces hard locks and serializes seen for overlapping calls', async () => {
  const locked = new Set(songs.slice(0, 16).map(s => s.id));
  const ctx = buildPickerContext(pickerScope({
    selection, playlistLock: locked, excludedIds: new Set(['id1']),
    hardRecentIds: new Set(['id2']), minTrackSec: 120,
  }), read);
  const list = songs.map(s => s.id === 'id3' ? { ...s, duration: 20 } : s);
  const [first, second] = await Promise.all([ctx.collectAsync(list), ctx.collectAsync(list)]);
  const ids = [...first, ...second].map(x => x.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['id1', 'id2', 'id3', 'id16', 'id17']) assert.ok(!ids.includes(id));
  assert.deepEqual([...ctx.seen.keys()], ids);
});

test('all strict show locks run before acoustic lookup, including empty pools', async () => {
  const choices = [
    { id: 'a', title: 'A', artist: 'X', year: 1975, genres: ['Punk Rock'], moods: ['night'], energy: 'high', vocalRanges: [[0, 1000]] },
    { id: 'b', title: 'B', artist: 'Y', year: 1995, genres: ['Jazz'], moods: ['calm'], energy: 'low', vocalRanges: [] },
    { id: 'c', title: 'C', artist: 'Z', year: 2015, genres: ['Jazz'], moods: ['night'], energy: 'low', vocalRanges: [[0, 500]] },
  ];
  const cases: [any, string[]][] = [
    [{ genreLock: ['Punk'] }, ['a']], [{ eraLock: [{ fromYear: 1990, toYear: 1999 }] }, ['b']],
    [{ moodLock: ['night'] }, ['a', 'c']], [{ energyLock: ['low'] }, ['b', 'c']],
    [{ vocalLock: 'instrumental' }, ['b']], [{ genreLock: ['none'] }, []],
  ];
  for (const [locks, expected] of cases) {
    let asked: readonly string[] = [];
    const ctx = buildPickerContext(pickerScope({ selection, ...locks }), async ids => {
      asked = ids;
      return null;
    });
    const got = await ctx.collectAsync(choices, 50);
    assert.deepEqual(got.map(x => x.id).sort(), expected);
    assert.deepEqual(asked.filter(id => id !== 'anchor').sort(), expected);
  }
});

test('single-artist exception keeps cap 8 rather than the normal cap 3', async () => {
  const sameArtist = songs.map(s => ({ ...s, artist: 'One artist' }));
  const ctx = buildPickerContext(pickerScope({ selection }), read);
  assert.equal((await ctx.collectAsync(sameArtist, 8, { maxPerArtist: Infinity })).length, 8);
});

test('soft track recency relaxes only when every eligible track is recent', async () => {
  const recentIds = new Set(songs.slice(0, 17).map(s => s.id));
  const ctx = buildPickerContext(pickerScope({ selection, recentIds }), read);
  assert.deepEqual((await ctx.collectAsync(songs)).map(x => x.id), ['id17']);
  const allRecent = new Set(songs.map(s => s.id));
  const rescue = buildPickerContext(pickerScope({ selection, recentIds: allRecent }), read);
  assert.equal((await rescue.collectAsync(songs)).length, 8);
});

test('seed cross-index rescue uses baseline on OFF and the async path on ON', async () => {
  const seedFixture = { audio: true, text: true,
    lookup: (_id: string, kind: 'audio' | 'text') => kind === 'audio' ? [] : songs };
  const runSeed = async (enabled: boolean) => {
    const ctx = buildPickerContext(pickerScope(enabled ? { selection } : {}), read, seedFixture);
    const random = Math.random;
    let draws = 0;
    Math.random = () => 1 - (draws++ / 100);
    try {
      const result = await ctx.seedSimilarityAsync('seed', 'audio');
      return { ...result, draws, seen: [...ctx.seen.keys()] };
    } finally { Math.random = random; }
  };
  const off = await runSeed(false), on = await runSeed(true);
  assert.equal(off.fellBack, true);
  assert.equal(on.fellBack, true);
  assert.equal(off.draws, songs.length);
  assert.equal(on.draws, off.draws);
  assert.deepEqual(off.tracks.map(x => x.id), off.seen);
  assert.deepEqual(on.tracks.map(x => x.id), on.seen);
  assert.notDeepEqual(on.seen, off.seen);
});

test('a stalled lookup falls back at the attempt deadline without re-shuffling', async () => {
  const off = await run(false);
  const started = performance.now();
  const stalled = await run(true, () => new Promise(() => {}));
  assert.deepEqual(stalled.ids, off.ids);
  assert.equal(stalled.draws, off.draws);
  assert.ok(performance.now() - started < 1500);
});

test('request tool builder explicitly clears the autonomous selection scope', () => {
  const agents = readFileSync(new URL('../src/broadcast/dj-agent/agents.ts', import.meta.url), 'utf8');
  assert.match(agents, /requestAgent[\s\S]*?buildPickerTools\(\{[\s\S]*?\.\.\.scope,\s*selection:\s*undefined/);
});
