// Synthetic catalogue-sized read test. No source audio is decoded or changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createEssentiaReader } from '../src/music/essentia-evidence.js';

test('indexed retrieval remains bounded with a 28k-track fixture', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'essentia-scale-'));
  try {
    const audio = join(dir, 'shared-fixture');
    writeFileSync(audio, 'test');
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
    const evidence = db.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,1)');
    const trait = db.prepare('INSERT INTO trait_value VALUES(?,?,?)');
    const insert = db.transaction(() => {
      for (let id = 1; id <= 28_000; id++) {
        evidence.run(id, `fixture-${id}`, audio, stat.size, stat.mtimeNs);
        trait.run(id, 'deam:arousal', 1 + (id % 81) / 10);
        trait.run(id, 'deam:valence', 1 + (id % 81) / 10);
        trait.run(id, 'binary:voice', (id % 101) / 100);
        trait.run(id, 'binary:danceable', (id % 101) / 100);
        trait.run(id, 'moods:calm', (id % 101) / 100);
      }
    });
    insert();
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT analysis_id FROM trait_value WHERE trait=? ORDER BY value DESC,analysis_id DESC LIMIT 256").all('deam:arousal') as { detail: string }[];
    assert.ok(plan.some(row => row.detail.includes('trait_rank')));
    db.close();
    const source = new Database(sourcePath);
    source.exec(`CREATE TABLE source_inventory(track_id TEXT PRIMARY KEY,source_path TEXT,nav_missing INTEGER,path_status TEXT);
      CREATE TABLE analysis_run(run_id TEXT PRIMARY KEY,code_version TEXT,provenance_json TEXT);
      CREATE TABLE track_analysis(analysis_id INTEGER PRIMARY KEY,track_id TEXT,source_size INTEGER,source_mtime_ns INTEGER,status TEXT,run_id TEXT);`);
    source.prepare('INSERT INTO analysis_run VALUES(?,?,?)').run('run', 'essentia-window-v1',
      JSON.stringify({ models, sample_rate: 16000, window_policy: 'up to five non-overlapping 10s windows: start, quartiles, end',
        inference_aggregation: 'mean over model patches per segment' }));
    const inventory = source.prepare('INSERT INTO source_inventory VALUES(?,?,0,?)');
    const analysis = source.prepare('INSERT INTO track_analysis VALUES(?,?,?,?,?,?)');
    source.transaction(() => {
      for (let id = 1; id <= 28_000; id++) {
        inventory.run(`fixture-${id}`, audio, 'mapped');
        analysis.run(id, `fixture-${id}`, stat.size, stat.mtimeNs, 'complete', 'run');
      }
    })();
    source.close();
    const reader = createEssentiaReader(path, hash, sourcePath);
    const started = performance.now();
    const matches = await reader.search({ arousal: 'high', voice: 'instrumental', mood: 'calm' });
    const elapsed = Math.round(performance.now() - started);
    assert.ok(matches && matches.length > 0 && matches.length <= 128);
    console.log(`synthetic_catalogue=28000 trait_hits=${matches.length} search_ms=${elapsed}`);
    const lookupStarted = performance.now();
    const profiles = await reader.lookup(matches.slice(0, 12));
    assert.equal(profiles?.size, 12);
    console.log(`batch_ids=12 profiles=${profiles?.size} lookup_ms=${Math.round(performance.now() - lookupStarted)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
