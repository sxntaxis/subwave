import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAgent } from '../src/broadcast/dj-agent/agents.js';
import { pickerScope, withPickerSeedFixtureForTest } from '../src/llm/internal/tools/picker/scope.js';
import { withAgentRunnerForTest } from '../src/llm/internal/agent-factory.js';
import type { djAgent } from '../src/llm/internal/strategy/agent.js';
import { withAcousticProbeForTest } from '../src/music/library-db/acoustic-index.js';
import { buildPickerContext } from '../src/llm/internal/tools/picker/scope.js';

test('actual requestAgent.run offers identical request candidates with flag off and on', async () => {
  const songs = Array.from({ length: 18 }, (_, i) => ({
    id: `fixture-${i}`, title: `track ${i}`, artist: `artist ${i}`, duration: 180,
  }));
  async function run(flag: string) {
    const previous = process.env.PICKER_VNEXT_AGENT, random = Math.random, fetch = globalThis.fetch;
    process.env.PICKER_VNEXT_AGENT = flag;
    let calls = 0, draws = 0;
    Math.random = () => { draws++; return 0.5; };
    globalThis.fetch = async () => { throw new Error('network prohibited in request fixture'); };
    let offered: unknown, rescue: any;
    const fake = (async (args: any) => {
      calls++;
      offered = await args.tools.showPlaylistTracks.execute({}, { toolCallId: 'offline', messages: [] });
      rescue = await args.tools.tracksLikeThis.execute({ songId: 'seed' }, { toolCallId: 'offline-seed', messages: [] });
      assert.ok(Array.isArray(rescue.tracks) && rescue.tracks.length > 0, 'seed rescue returned actual remaining tracks');
      assert.ok(typeof rescue.note === 'string');
      const ids = (offered as Array<{ id: string }>).map(item => item.id);
      assert.ok(ids.length > 0);
      assert.ok(!ids.includes('fixture-1'));
      assert.equal(args.validate({ id: ids[0] }), true);
      assert.equal(args.validate({ id: 'not-offered' }), false);
      return { object: { id: ids[0], ack: 'ok' }, steps: 1, toolCalls: [] };
    }) as typeof djAgent;
    try {
      const scope = pickerScope({ playlistTracks: songs, playlistLock: new Set(songs.map(s => s.id)),
        excludedIds: new Set(['fixture-1']), selection: { predecessorId: 'fixture-anchor', recentAiredIds: [] } });
      const probe = { starts: 0, lookups: 0 };
      const result = await withAcousticProbeForTest(probe, () =>
        withPickerSeedFixtureForTest({ text: true, audio: true,
          lookup: (_id, kind) => kind === 'text' ? [] : songs }, () =>
          withAgentRunnerForTest(fake, () => requestAgent.run({ scope, messages: [] }))));
      assert.deepEqual(probe, { starts: 0, lookups: 0 });
      return { offered, rescue, seen: [...result.extras.seen.keys()], object: result.object, draws, calls, probe };
    } finally {
      if (previous === undefined) delete process.env.PICKER_VNEXT_AGENT;
      else process.env.PICKER_VNEXT_AGENT = previous;
      Math.random = random; globalThis.fetch = fetch;
    }
  }
  assert.deepEqual(await run('0'), await run('1'));
  const probe = { starts: 0, lookups: 0 };
  const ctx = buildPickerContext(pickerScope({ selection: { predecessorId: 'anchor', recentAiredIds: [] } }));
  await withAcousticProbeForTest(probe, () => ctx.collectAsync(songs));
  assert.equal(probe.lookups, 1, 'positive control must reach the acoustic bridge');
});

test('autonomous acoustic positive control changes eligible offers', async () => {
  const songs = Array.from({ length: 18 }, (_, i) => ({
    id: `candidate-${i}`, title: `track ${i}`, artist: `artist ${i}`, duration: 180,
  }));
  const read = async (ids: readonly string[]) => ids.map(id => ({
    id, track: { bpm: id === 'anchor' || Number(id.slice(10)) >= 12 ? 80 : 133,
      musical_key: null, pace_json: null, key_ranges_json: null, duration_sec: 180 }, vector: null,
  }));
  async function offers(enabled: boolean) {
    const ctx = buildPickerContext(pickerScope(enabled
      ? { selection: { predecessorId: 'anchor', recentAiredIds: [] } } : {}), read);
    const old = Math.random;
    let n = 0;
    Math.random = () => 1 - n++ / 100;
    try { return (await ctx.collectAsync(songs, 8)).map(s => s.id); }
    finally { Math.random = old; }
  }
  const off = await offers(false), on = await offers(true);
  assert.notDeepEqual(on, off);
  assert.ok(on.every(id => songs.some(song => song.id === id)));
});
