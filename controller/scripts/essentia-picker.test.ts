import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'essentia-picker-'));
const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const { buildPickerContext, pickerScope } = await import('../src/llm/internal/tools/picker/scope.js');
const { withEssentiaReaderForTest } = await import('../src/music/essentia-evidence.js');
const { createPickerAuditRecorder } = await import('../src/observability/picker-audit.js');
const playlistTool = (await import('../src/llm/internal/tools/picker/tools/show-playlist-tracks.js')).default;
const traitTool = (await import('../src/llm/internal/tools/picker/tools/find-by-audio-traits.js')).default;
await library.load();
for (const id of ['allowed', 'recent', 'excluded', 'outside']) {
  db.upsertTrackMeta(id, { title: id, artist: `artist-${id}`, duration: 180 });
}
const reader = {
  async lookup(ids: readonly string[]) {
    return new Map(ids.map(id => [id, { arousal: 7, voice: 0.2 }]));
  },
  async search() { return ['recent', 'excluded', 'outside', 'allowed']; },
};
const selection = { predecessorId: 'anchor', recentAiredIds: [] };
const options = { toolCallId: 'fixture', messages: [] };

test('trait discovery directly yields selectable profiles and respects locks', async () => {
  const availabilityEvents: any[] = [];
  const availabilityOnly = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'availability-fixture', write: event => availabilityEvents.push(event),
  });
  const events: any[] = [];
  const audit = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'fixture', write: event => events.push(event),
  });
  await withEssentiaReaderForTest(reader, async () => {
    const availabilityContext = buildPickerContext(pickerScope({
      essentiaDiscovery: true, essentiaAudit: availabilityOnly,
    }), async () => null);
    assert.equal(traitTool.available?.(availabilityContext), true);
    availabilityOnly.finish({ outcome: 'rejected' });
    assert.equal(availabilityEvents[0].essentia.trait_tool_invocations, 0);
    assert.equal(availabilityEvents[0].essentia.trait_result, 'not_invoked');

    const ctx = buildPickerContext(pickerScope({
      selection, essentiaDiscovery: true, playlistLock: new Set(['allowed', 'recent', 'excluded']),
      hardRecentIds: new Set(['recent']), excludedIds: new Set(['excluded']), essentiaAudit: audit,
    }), async () => null);
    assert.equal(traitTool.available?.(ctx), true);
    const result = await (traitTool.build(ctx) as any).execute({ arousal: 'high' }, options);
    assert.deepEqual(result.map((s: any) => s.id), ['allowed']);
    assert.equal(ctx.seen.get('allowed').id, result[0].id);
    assert.equal(ctx.seen.get('allowed').audio_profile, undefined);
    assert.equal(result[0].audio_profile.arousal_1_9, 7);
    audit.finish({ outcome: 'success', chosenId: 'allowed' });
    assert.deepEqual(events[0].essentia, {
      availability: 'available',
      profiled_candidates_exposed: 1,
      trait_tool_invocations: 1,
      trait_candidates_exposed: 1,
      trait_result: 'returned',
      chosen_had_exposed_profile: true,
      chosen_from_trait_result: true,
    });
  });
});

test('existing playlist results hydrate after admission and request context remains isolated', async () => {
  await withEssentiaReaderForTest(reader, async () => {
    const songs = ['allowed', 'recent'].map(id => ({ id, title: id, artist: id, duration: 180 }));
    const ctx = buildPickerContext(pickerScope({ selection, essentiaDiscovery: true, playlistTracks: songs, hardRecentIds: new Set(['recent']) }), async () => null);
    const result = await (playlistTool.build(ctx) as any).execute({}, options);
    assert.deepEqual(result.map((s: any) => s.id), ['allowed']);
    assert.equal(result[0].audio_profile.voice_score, 0.2);
    assert.equal(ctx.seen.get('allowed').id, result[0].id);
    assert.equal(ctx.seen.get('allowed').audio_profile, undefined);
    const request = buildPickerContext(pickerScope({ resolveReferences: true }));
    assert.equal(request.essentia, null);
    assert.equal(traitTool.available?.(request), false);
    const withoutPredecessor = buildPickerContext(pickerScope({ essentiaDiscovery: true }));
    assert.equal(traitTool.available?.(withoutPredecessor), true);
  });
});

test('eligible evidence cohort applies pinned playlist, exclusions, hard recency and seen without registering tracks', async () => {
  await withEssentiaReaderForTest(reader, async () => {
    const seen = new Map([['outside', { id: 'outside' }]]);
    const ctx = buildPickerContext(pickerScope({
      essentiaDiscovery: true,
      playlistLock: new Set(['allowed', 'recent', 'excluded', 'outside']),
      hardRecentIds: new Set(['recent']), excludedIds: new Set(['excluded']), seen,
    }));
    const result = await ctx.eligibleEvidenceIds(performance.now() + 5000);
    assert.deepEqual(result, { status: 'complete', ids: ['allowed'] });
    assert.deepEqual([...seen.keys()], ['outside']);
    assert.deepEqual(await ctx.eligibleEvidenceIds(performance.now() - 1), { status: 'incomplete' });
    const request = buildPickerContext(pickerScope({ resolveReferences: true }));
    assert.deepEqual(await request.eligibleEvidenceIds(performance.now() + 5000), { status: 'incomplete' });
  });
});

test('opt-in joint trait discovery offers a deep-ranked pinned track through seen', async () => {
  const previous = process.env.SUBWAVE_MUSIC_EVIDENCE_V2;
  process.env.SUBWAVE_MUSIC_EVIDENCE_V2 = '1';
  db.upsertTrackMeta('deep-piano', { title: 'deep-piano', artist: 'deep-artist', duration: 180 });
  const global = [...Array.from({ length: 300 }, (_, i) => `outside-${i}`), 'deep-piano'];
  const jointReader = {
    ...reader,
    async searchJoint(request: { eligibleIds?: string[] | null }) {
      const ids = request.eligibleIds ? global.filter(id => request.eligibleIds!.includes(id)) : global.slice(0, 12);
      return { results: ids.slice(0, 12).map(id => ({
        id, tier: 'full' as const, score: 0.9, evidenceCoverage: 1, matchedPreferences: 3, requestedPreferences: 3,
      })), rankedCount: ids.length, rejectedFreshness: 0, verificationLimited: false };
    },
  };
  try {
    await withEssentiaReaderForTest(jointReader, async () => {
      const ctx = buildPickerContext(pickerScope({ essentiaDiscovery: true, playlistLock: new Set(['deep-piano']) }));
      const result = await (traitTool.build(ctx) as any).execute({ arousal: 'low', voice: 'instrumental', instrument: 'piano' }, options);
      assert.deepEqual(result.map((track: any) => track.id), ['deep-piano']);
      assert.equal(ctx.seen.get('deep-piano')?.id, 'deep-piano');
    });
  } finally {
    if (previous === undefined) delete process.env.SUBWAVE_MUSIC_EVIDENCE_V2;
    else process.env.SUBWAVE_MUSIC_EVIDENCE_V2 = previous;
  }
});

test('an incomplete constrained v2 cohort is reported unavailable without leaking partial results', async () => {
  const previous = process.env.SUBWAVE_MUSIC_EVIDENCE_V2;
  process.env.SUBWAVE_MUSIC_EVIDENCE_V2 = '1';
  const ids = Array.from({ length: 130 }, (_, i) => `cohort-${i}`);
  for (const id of ids) db.upsertTrackMeta(id, { title: id, artist: `artist-${id}`, duration: 180 });
  let calls = 0;
  const jointReader = {
    ...reader,
    async searchJoint(request: { eligibleIds?: string[] | null }) {
      calls++;
      if (calls === 2) return null;
      const id = request.eligibleIds![0];
      return { results: [{ id, tier: 'full' as const, score: 0.9, evidenceCoverage: 1,
        matchedPreferences: 1, requestedPreferences: 1 }], rankedCount: 1, rejectedFreshness: 0 };
    },
  };
  try {
    await withEssentiaReaderForTest(jointReader, async () => {
      const ctx = buildPickerContext(pickerScope({ essentiaDiscovery: true, playlistLock: new Set(ids) }));
      const result = await (traitTool.build(ctx) as any).execute({ instrument: 'piano' }, options);
      assert.equal(calls, 2);
      assert.deepEqual(result.tracks, []);
      assert.match(result.note, /could not finish/);
      assert.equal(ctx.seen.size, 0);
    });
  } finally {
    if (previous === undefined) delete process.env.SUBWAVE_MUSIC_EVIDENCE_V2;
    else process.env.SUBWAVE_MUSIC_EVIDENCE_V2 = previous;
  }
});
