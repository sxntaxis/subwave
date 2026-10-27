import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStationClient } from '../lib/stationClient';

test('current lyrics are fetched by exact Subsonic ID with no-store and abort', async () => {
  const previous = globalThis.fetch;
  const client = createStationClient({ apiUrl: '/api', streams: { mp3: '/stream.mp3', opus: null } });
  const abort = new AbortController();
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(input, '/api/lyrics/current?songId=song%20id');
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.signal, abort.signal);
      return Response.json({ songId: 'song id', document: { id: 'navidrome:song id', timing: 'plain', lines: [{ id: '0', text: 'Original text' }] } });
    };
    const result = await client.currentLyrics('song id', abort.signal);
    assert.equal(result.document?.lines[0]?.text, 'Original text');
  } finally { globalThis.fetch = previous; }
});

test('stale or errored lyric responses are never accepted as success', async () => {
  const previous = globalThis.fetch;
  const client = createStationClient({ apiUrl: '/api', streams: { mp3: '/stream.mp3', opus: null } });
  try {
    globalThis.fetch = async () => Response.json({ songId: 'different', document: null });
    await assert.rejects(client.currentLyrics('song'), /Invalid lyrics response/);
    globalThis.fetch = async () => Response.json({ error: 'stale song' }, { status: 409 });
    await assert.rejects(client.currentLyrics('song'), /409/);
  } finally { globalThis.fetch = previous; }
});
