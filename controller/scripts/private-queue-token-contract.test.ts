import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const radio = readFileSync(new URL('../../liquidsoap/radio.liq', import.meta.url), 'utf8');

test('private queue identity is returned only by pre-cross marker, never inserted into stream metadata or logs', () => {
  assert.match(radio, /music_meta\.on_metadata\(synchronous=false, on_meta\)/);
  assert.match(radio, /subwave_queue_token = if queue_token == "" then null else queue_token end/);
  assert.match(radio, /subwave_clip = is_clip/);
  const streamMetadata = radio.match(/radio\.insert_metadata\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  assert.deepEqual([...streamMetadata.matchAll(/\("([^"]+)"/g)].map(match => match[1]), [
    'title', 'artist', 'album',
  ]);
  assert.doesNotMatch(radio, /log\("Queueing:[^"\n]*#\{contents\}/i);
  assert.doesNotMatch(radio, /log\("on_meta: title=/i);
  assert.match(radio, /log\("Queueing controller track handoff"\)/);
});
