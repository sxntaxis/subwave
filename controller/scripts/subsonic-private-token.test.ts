import assert from 'node:assert/strict';
import test from 'node:test';

test('only valid insertion tokens reach full-track annotation; clips are explicitly tokenless', async () => {
  const { getAnnotatedUri, getClipUri } = await import('../src/music/subsonic.js');
  const song = { id: 'id', title: 'Title', artist: 'Artist', album: 'Album' };
  const token = 'f'.repeat(32);
  const uri = getAnnotatedUri(song, { queueToken: token });
  assert.ok(uri.includes(`subwave_queue_token="${token}"`));
  assert.ok(!getAnnotatedUri(song, { queueToken: 'bad-token' }).includes('subwave_queue_token='));
  const clip = getClipUri(song, '/tmp/fixture.wav', 6);
  assert.ok(clip.includes('subwave_clip="1"'));
  assert.ok(clip.includes('subwave_queue_token=""'));
  assert.ok(!clip.includes(token));
});
