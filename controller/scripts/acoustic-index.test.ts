import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createAcousticIndex } from '../src/music/library-db/acoustic-index.js';

test('cold index fails open, warm index serves a coherent generation and invalidates after a write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acoustic-index-'));
  const path = join(dir, 'fixture.db');
  const db = new Database(path);
  sqliteVec.load(db);
  db.pragma('journal_mode=WAL');
  db.exec('CREATE TABLE tracks(id TEXT PRIMARY KEY,bpm REAL,musical_key TEXT,pace_json TEXT,key_ranges_json TEXT,duration_sec REAL)');
  db.exec('CREATE VIRTUAL TABLE track_audio_vectors USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[512])');
  db.prepare('INSERT INTO tracks VALUES(?,?,?,?,?,?)').run('fixture', 120, '8A', '[]', '[]', 240);
  const vector = new Float32Array(512); vector[0] = 0.5;
  db.prepare('INSERT INTO track_audio_vectors(id,embedding) VALUES(?,?)').run('fixture', Buffer.from(vector.buffer));
  const index = createAcousticIndex(path);
  try {
    assert.equal(await index.lookup(['fixture'], 750), null);
    assert.equal(await index.whenReady(5000), true);
    const rows = await index.lookup(['fixture', 'unknown'], 750);
    assert.equal(rows?.[0].track?.bpm, 120);
    assert.equal(rows?.[0].vector?.[0], 0.5);
    assert.equal(rows?.[1].track, null);
    assert.ok(index.metrics.rssBytes <= 256 * 1024 * 1024);
    db.prepare('UPDATE tracks SET bpm=? WHERE id=?').run(121, 'fixture');
    assert.equal(await index.lookup(['fixture'], 750), null);
    assert.equal(await index.whenReady(5000), true);
    assert.equal((await index.lookup(['fixture'], 750))?.[0].track?.bpm, 121);
    assert.equal(await index.lookup(Array.from({ length: 263 }, (_, i) => `${i}`), 750), null);
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => index.lookup(['fixture'], 750)));
    assert.equal(concurrent.filter(Boolean).length, 8);
    assert.ok(concurrent.every(rows => rows?.[0].track?.bpm === 121));
    const pending = Array.from({ length: 8 }, () => index.lookup(['fixture'], 750));
    index.close();
    assert.deepEqual(await Promise.all(pending), Array(8).fill(null));
    assert.equal(await index.lookup(['fixture'], 750), null);
  } finally {
    index.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed warmup remains unavailable and close is terminal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acoustic-missing-'));
  const index = createAcousticIndex(join(dir, 'missing.db'));
  try {
    assert.equal(await index.whenReady(500), false);
    assert.equal(index.isFailed(), true);
    assert.equal(await index.lookup(['fixture'], 750), null);
    index.close();
    assert.equal(await index.whenReady(5), false);
  } finally {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
