import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicNowPlaying } from '../src/broadcast/queue/now-playing-public.js';

test('public now-playing copy omits private token and clip marker', () => {
  const raw = { title: 'Song', artist: 'Artist', subwave_queue_token: 'private', subwave_clip: '1' };
  const result = publicNowPlaying(raw);
  assert.deepEqual(result, { title: 'Song', artist: 'Artist' });
  assert.equal(raw.subwave_queue_token, 'private');
  assert.equal(publicNowPlaying(null), null);
});
