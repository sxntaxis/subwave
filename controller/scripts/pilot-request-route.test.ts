import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { djAgent } from '../src/llm/internal/strategy/agent.js';

const previousStateDir = process.env.STATE_DIR;
const stateDir = mkdtempSync(join(tmpdir(), 'pilot-request-route-'));
process.env.STATE_DIR = stateDir;
const [
  { requestAgent },
  { pickerScope, withPickerSeedFixtureForTest, buildPickerContext },
  { withAgentRunnerForTest },
  { withAcousticProbeForTest },
  library,
  libraryDb,
] = await Promise.all([
  import('../src/broadcast/dj-agent/agents.js'),
  import('../src/llm/internal/tools/picker/scope.js'),
  import('../src/llm/internal/agent-factory.js'),
  import('../src/music/library-db/acoustic-index.js'),
  import('../src/music/library.js'),
  import('../src/music/library-db.js'),
]);
const songs = Array.from({ length: 18 }, (_, i) => ({
  id: `fixture-${i}`, title: `track ${i}`, artist: `artist ${i}`, duration: 180,
}));
await library.load();
for (const song of songs) libraryDb.upsertTrackMeta(song.id, song);
// Give both executions the same mixed airing history: some candidates have
// durable plays and others are provably unaired. The DB is loaded and seeded
// before either run, so the rescue tool cannot warm history between them.
for (let i = 6; i < songs.length; i++) {
  libraryDb.recordPlay({
    trackId: songs[i].id,
    title: songs[i].title,
    artist: songs[i].artist,
    album: null,
    playedAt: new Date(Date.now() - (i - 5) * 86400000).toISOString(),
    source: 'ai',
    requestedBy: null,
    showId: null,
    showName: null,
  });
}

after(() => {
  library.shutdown();
  if (previousStateDir === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = previousStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

test('actual requestAgent.run offers identical request candidates with flag off and on', async () => {
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
  const off = await run('0');
  const on = await run('1');
  assert.deepEqual(off, on);
  assert.ok((off.offered as any[]).some(item => item.id === 'fixture-0' && item.unaired === true),
    'the deterministic history fixture retains the unaired annotation');
  assert.ok((off.offered as any[]).some(item => item.id.startsWith('fixture-') && !item.unaired
    && typeof item.play_count === 'number'), 'played candidates retain their history-derived fields');
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
