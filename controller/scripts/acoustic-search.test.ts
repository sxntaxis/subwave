import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createAcousticAttempt, queryAcousticsInWorker } from '../src/music/library-db/acoustic-search.js';

test('attempt batches and caches IDs, enforces caps', async () => {
  let calls = 0;
  const attempt = createAcousticAttempt(async (_path, ids) => {
    calls++;
    return { version: 1, rows: ids.map(id => ({ id, track: null, vector: null })), queries: ids.length * 2, bytes: 0 };
  }, () => 10, () => ({ path: 'fixture', nonce: 'a' }));
  assert.ok(await attempt.hydrate(['a', 'b'], ['anchor']));
  assert.ok(await attempt.hydrate(['a'], ['anchor']));
  assert.equal(calls, 1);
  assert.equal(attempt.metrics.queries, 6);
  assert.equal(await attempt.hydrate(Array.from({ length: 257 }, (_, i) => `v${i}`), []), null);
  assert.equal(calls, 1);
});

test('late result is discarded and remaining attempt degrades', async () => {
  let tick = 0;
  const attempt = createAcousticAttempt(async (_path, ids) => {
    tick = 751;
    return { version: 1, rows: ids.map(id => ({ id, track: null, vector: null })), queries: 2, bytes: 0 };
  }, () => tick, () => ({ path: 'fixture', nonce: 'a' }));
  assert.equal(await attempt.hydrate(['a'], []), null);
  assert.equal(await attempt.hydrate(['b'], []), null);
  assert.equal(attempt.metrics.timedOut, true);
});

test('database changes and worker failures fail closed', async () => {
  let reads = 0;
  const attempt = createAcousticAttempt(async (_path, ids) =>
    ({ version: 1, rows: ids.map(id => ({ id, track: null, vector: null })), queries: 2, bytes: 0 }),
  () => 0, () => ({ path: 'fixture', nonce: ++reads === 1 ? 'a' : 'b' }));
  assert.equal(await attempt.hydrate(['a'], []), null);
  assert.equal(await queryAcousticsInWorker('/nonexistent/db', ['a'], 500), null);
  assert.equal(await queryAcousticsInWorker('/nonexistent/db', Array(263).fill('a'), 500), null);
});

test('worker returns exact metadata and vector from a read-only fixture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acoustic-worker-'));
  const path = join(dir, 'fixture.db');
  const db = new Database(path);
  try {
    sqliteVec.load(db);
    db.exec('CREATE TABLE tracks(id TEXT PRIMARY KEY,bpm REAL,musical_key TEXT,pace_json TEXT,key_ranges_json TEXT,duration_sec REAL)');
    db.exec('CREATE VIRTUAL TABLE track_audio_vectors USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[512])');
    db.prepare('INSERT INTO tracks VALUES(?,?,?,?,?,?)').run('fixture', 120, '8A', '[]', '[]', 240);
    const vector = new Float32Array(512); vector[0] = 0.5;
    db.prepare('INSERT INTO track_audio_vectors(id,embedding) VALUES(?,?)').run('fixture', Buffer.from(vector.buffer));
    db.close();
    const result = await queryAcousticsInWorker(path, ['fixture', 'absent'], 5000);
    assert.ok(result);
    assert.equal(result.queries, 4);
    assert.equal(result.rows[0].track?.bpm, 120);
    assert.equal(result.rows[0].vector?.length, 512);
    assert.equal(result.rows[0].vector?.[0], 0.5);
    assert.equal(result.rows[1].track, null);
    assert.equal(result.rows[1].vector, null);
  } finally {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
