import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { createEssentiaReader, createSocketEssentiaReader, getEssentiaReader } from '../src/music/essentia-evidence.js';

test('indexed read checks freshness and rejects ambiguous identities', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'essentia-reader-'));
  try {
    const audio = join(dir, 'audio');
    writeFileSync(audio, 'fixture');
    const stat = statSync(audio, { bigint: true });
    const path = join(dir, 'index.sqlite');
    const sourcePath = join(dir, 'source.sqlite');
    const models = { fixture: 'model' };
    const hash = createHash('sha256').update(JSON.stringify(models)).digest('hex');
    const db = new Database(path);
    db.exec(`CREATE TABLE index_contract(id INTEGER PRIMARY KEY,models_sha256 TEXT,version INTEGER);
      INSERT INTO index_contract VALUES(1,'${hash}',2);
      CREATE TABLE evidence(analysis_id INTEGER PRIMARY KEY,track_id TEXT,source_path TEXT,
      source_size INTEGER,source_mtime_ns INTEGER,ready INTEGER);
      CREATE INDEX evidence_track ON evidence(track_id,ready);
      CREATE TABLE trait_value(analysis_id INTEGER,trait TEXT,value REAL,PRIMARY KEY(analysis_id,trait));
      CREATE INDEX trait_rank ON trait_value(trait,value,analysis_id);`);
    const put = db.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,1)');
    put.run(1, 'fresh', audio, stat.size, stat.mtimeNs);
    put.run(2, 'stale', audio, stat.size + 1n, stat.mtimeNs);
    put.run(3, 'ambiguous', audio, stat.size, stat.mtimeNs);
    put.run(4, 'ambiguous', audio, stat.size, stat.mtimeNs);
    const trait = db.prepare('INSERT INTO trait_value VALUES(?,?,?)');
    for (const id of [1, 2, 3, 4]) trait.run(id, 'deam:arousal', 7);
    trait.run(1, 'binary:voice', 0.2);
    db.close();
    const source = new Database(sourcePath);
    source.exec(`CREATE TABLE source_inventory(track_id TEXT PRIMARY KEY,source_path TEXT,nav_missing INTEGER,path_status TEXT);
      CREATE TABLE analysis_run(run_id TEXT PRIMARY KEY,code_version TEXT,provenance_json TEXT);
      CREATE TABLE track_analysis(analysis_id INTEGER PRIMARY KEY,track_id TEXT,source_size INTEGER,source_mtime_ns INTEGER,status TEXT,run_id TEXT);`);
    const provenance = JSON.stringify({ models, sample_rate: 16000,
      window_policy: 'up to five non-overlapping 10s windows: start, quartiles, end',
      inference_aggregation: 'mean over model patches per segment' });
    source.prepare('INSERT INTO analysis_run VALUES(?,?,?)').run('run', 'essentia-window-v1', provenance);
    const inventory = source.prepare('INSERT INTO source_inventory VALUES(?,?,0,?)');
    const analysis = source.prepare('INSERT INTO track_analysis VALUES(?,?,?,?,?,?)');
    for (const [n, id] of [[1, 'fresh'], [2, 'stale'], [3, 'ambiguous'], [4, 'ambiguous']] as const) {
      if (n !== 4) inventory.run(id, audio, 'mapped');
      analysis.run(n, id, n === 2 ? stat.size + 1n : stat.size, stat.mtimeNs, 'complete', 'run');
    }
    source.close();
    const reader = createEssentiaReader(path, hash, sourcePath);
    const result = await reader.lookup(['fresh', 'stale', 'ambiguous', 'missing']);
    assert.deepEqual([...result!.keys()], ['fresh']);
    assert.equal(result!.get('fresh')?.arousal, 7);
    assert.deepEqual(await reader.search({ arousal: 'high', voice: 'instrumental' }), ['fresh']);
    const writer = new Database(sourcePath);
    writer.prepare("UPDATE track_analysis SET status='failed' WHERE analysis_id=1").run();
    writer.close();
    assert.equal((await reader.lookup(['fresh']))?.size, 0);
    writeFileSync(audio, 'changed-size');
    assert.deepEqual([...((await reader.lookup(['fresh']))!).keys()], []);
    assert.deepEqual(await reader.search({ arousal: 'high' }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('production gate requires a recent socket readiness marker', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'essentia-gate-'));
  const previous = process.env.SUBWAVE_ESSENTIA_SOCKET;
  const server = createServer();
  try {
    const path = join(dir, 'evidence.sock');
    await new Promise<void>(resolve => server.listen(path, resolve));
    process.env.SUBWAVE_ESSENTIA_SOCKET = path;
    assert.equal(getEssentiaReader(), null);
    const marker = { ready: true, updated_ms: Date.now() };
    const markerPath = join(dir, 'ready.json');
    writeFileSync(markerPath, JSON.stringify(marker));
    assert.ok(getEssentiaReader());
    writeFileSync(markerPath, JSON.stringify({ ...marker, updated_ms: Date.now() - 100_000 }));
    assert.equal(getEssentiaReader(), null);
    writeFileSync(markerPath, JSON.stringify({ ...marker, ready: false }));
    assert.equal(getEssentiaReader(), null);
  } finally {
    if (previous === undefined) delete process.env.SUBWAVE_ESSENTIA_SOCKET;
    else process.env.SUBWAVE_ESSENTIA_SOCKET = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a continuously trickling socket cannot extend the absolute deadline', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'essentia-timeout-'));
  const server = createServer(socket => {
    const timer = setInterval(() => socket.write(' '), 100);
    socket.on('close', () => clearInterval(timer));
    socket.on('error', () => clearInterval(timer));
  });
  try {
    const path = join(dir, 'evidence.sock');
    await new Promise<void>(resolve => server.listen(path, resolve));
    const started = performance.now();
    const result = await createSocketEssentiaReader(path).lookup(['fixture']);
    assert.equal(result, null);
    assert.ok(performance.now() - started < 1800);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
