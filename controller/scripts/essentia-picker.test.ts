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
  await withEssentiaReaderForTest(reader, async () => {
    const ctx = buildPickerContext(pickerScope({
      selection, essentiaDiscovery: true, playlistLock: new Set(['allowed', 'recent', 'excluded']),
      hardRecentIds: new Set(['recent']), excludedIds: new Set(['excluded']),
    }), async () => null);
    assert.equal(traitTool.available?.(ctx), true);
    const result = await (traitTool.build(ctx) as any).execute({ arousal: 'high' }, options);
    assert.deepEqual(result.map((s: any) => s.id), ['allowed']);
    assert.equal(ctx.seen.get('allowed').id, result[0].id);
    assert.equal(ctx.seen.get('allowed').audio_profile, undefined);
    assert.equal(result[0].audio_profile.arousal_1_9, 7);
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
