import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const root = mkdtempSync(join(tmpdir(), 'subwave-vector-worker-'));
process.env.STATE_DIR = root;
const { setHandle } = await import('../src/music/library-db/handle.js');
const { queryKnn } = await import('../src/music/library-db/vectors.js');
const { searchKnnAsync, closeVectorSearch } = await import('../src/music/library-db/vector-search.js');
const db = new Database(join(root, 'library.db'));
sqliteVec.load(db);
db.exec('CREATE VIRTUAL TABLE track_audio_vectors USING vec0(id TEXT PRIMARY KEY, embedding float[512] distance_metric=cosine)');
const insert = db.prepare('INSERT INTO track_audio_vectors(id, embedding) VALUES (?, ?)');
const vector = (n: number) => {
  const value = new Float32Array(512);
  value[0] = Math.cos(n / 10000);
  value[1] = Math.sin(n / 10000);
  return value;
};
db.transaction(() => {
  for (let i = 0; i < 4000; i++) insert.run(`song-${i}`, Buffer.from(vector(i).buffer));
})();
setHandle({ db, nonce: 'first' });
after(() => {
  closeVectorSearch();
  setHandle({ db: null });
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('worker preserves neighbour ordering, seed exclusion and widening past excluded results', async () => {
  const excludeIds = new Set(Array.from({ length: 90 }, (_, i) => `song-${i + 1}`));
  const expected = queryKnn(db, Buffer.from(vector(0).buffer), 8, 'song-0', 'track_audio_vectors', excludeIds);
  const actual = await searchKnnAsync('track_audio_vectors', 'song-0', 8, { excludeIds });
  assert.deepEqual(actual, expected);
  assert.equal(actual.length, 8);
  assert.ok(actual.every(hit => hit.id !== 'song-0' && !excludeIds.has(hit.id)));
});

test('main event loop remains responsive during native searches', async () => {
  let ticks = 0;
  let longestGap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    longestGap = Math.max(longestGap, now - last);
    last = now;
    ticks++;
  }, 5);
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => searchKnnAsync('track_audio_vectors', vector(5), 60)));
    assert.ok(results.every(hits => hits.length === 60));
    assert.ok(ticks > 0, 'timers must run while SQLite computes');
    assert.ok(longestGap < 250, `search blocked timers for ${longestGap}ms`);
  } finally { clearInterval(timer); }
});

test('missing seeds return no neighbours and a library swap invalidates in-flight results', async () => {
  assert.deepEqual(await searchKnnAsync('track_audio_vectors', 'missing', 8), []);
  const pending = searchKnnAsync('track_audio_vectors', vector(5), 60);
  setHandle({ nonce: 'restored' });
  assert.deepEqual(await pending, []);
});
