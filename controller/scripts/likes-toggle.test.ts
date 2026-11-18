import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import express from 'express';

const root = mkdtempSync(join(tmpdir(), 'subwave-like-toggle-'));
process.env.STATE_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));
const likes = await import('../src/broadcast/likes.js');
const { queue } = await import('../src/broadcast/queue.js');
const { setCache } = await import('../src/settings/store.js');
const { router } = await import('../src/routes/likes.js');

test('listener unlike is idempotent and leaves other people, airings and operator hearts intact', async () => {
  await likes.clear();
  const track = { id: 'same-song', title: 'Same song' };
  await likes.recordLike({ track, startedAt: 'first', ip: 'listener-a' });
  await likes.recordLike({ track, startedAt: 'second', ip: 'listener-a' });
  await likes.recordLike({ track, startedAt: 'second', ip: 'listener-b' });
  await likes.operatorLike(track);
  assert.deepEqual(await likes.removeLike({ songId: track.id, startedAt: 'second', ip: 'listener-a' }), { removed: true, count: 3 });
  assert.deepEqual(await likes.removeLike({ songId: track.id, startedAt: 'second', ip: 'listener-a' }), { removed: false, count: 3 });
  assert.equal((await likes.status({ songId: track.id, startedAt: 'first', ip: 'listener-a' })).liked, true);
  assert.equal((await likes.status({ songId: track.id, startedAt: 'second', ip: 'listener-b' })).liked, true);
  assert.equal(likes.operatorLiked(track.id), true);
  assert.deepEqual(await likes.recordLike({ track, startedAt: 'second', ip: 'listener-a' }), { ok: true, duplicate: false, count: 4 });
});

test('HTTP like → unlike → like works immediately, rejects a stale undo, and respects disabled likes', async () => {
  await likes.clear();
  setCache({ likes: { enabled: true, starInNavidrome: false } } as never);
  const originalNowPlaying = queue.getNowPlaying;
  queue.getNowPlaying = async () => ({ subsonic_id: 'on-air', title: 'On air', artist: 'Artist', startedAt: 'airing-1' });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/like`;
  const request = (method: string, songId = 'on-air', ip = 'test-listener') => fetch(url, {
    method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    ...(method === 'GET' ? {} : { body: JSON.stringify({ songId }) }),
  });
  try {
    for (const [method, liked, count] of [['POST', true, 1], ['DELETE', false, 0], ['POST', true, 1]] as const) {
      const response = await request(method);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.liked, liked);
      assert.equal(data.count, count);
      assert.equal((await (await request('GET')).json()).liked, liked);
    }
    const stale = await request('DELETE', 'ended-song', 'stale-listener');
    assert.equal(stale.status, 409);
    assert.equal(likes.stats().total, 1);
    setCache({ likes: { enabled: false } } as never);
    assert.equal((await request('DELETE')).status, 403);
    assert.equal(likes.stats().total, 1);
  } finally {
    queue.getNowPlaying = originalNowPlaying;
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
