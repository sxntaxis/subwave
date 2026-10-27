import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStationClient } from '../lib/stationClient';

test('feed HTTP errors and malformed payloads reject instead of becoming missing metadata', async () => {
  const original = globalThis.fetch;
  const client = createStationClient({ apiUrl: '/api', streams: { mp3: '/stream.mp3', opus: '/stream.opus' } });
  try {
    globalThis.fetch = async () => Response.json({ error: 'temporarily unavailable' }, { status: 503 });
    await assert.rejects(client.nowPlaying(), /503/);
    await assert.rejects(client.state(), /503/);
    globalThis.fetch = async () => Response.json({ error: 'wrong response shape' });
    await assert.rejects(client.nowPlaying(), /Invalid/);
    await assert.rejects(client.state(), /Invalid/);
    globalThis.fetch = async (_input, options) => {
      assert.equal(options?.cache, 'no-store');
      assert.ok(options?.signal);
      return Response.json({ nowPlaying: { title: 'Mayonaka No Door', artist: 'Miki Matsubara' }, context: null });
    };
    assert.equal((await client.nowPlaying()).nowPlaying?.title, 'Mayonaka No Door');
  } finally { globalThis.fetch = original; }
});
