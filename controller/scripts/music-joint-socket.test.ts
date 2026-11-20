import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { searchJointSocket } from '../src/music/essentia-evidence.js';

test('private socket joint search reaches a rare candidate beyond the primary top 256', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'music-v2-socket-'));
  const audio = join(dir, 'audio');
  writeFileSync(audio, 'fixture');
  const staleAudio = join(dir, 'stale-audio');
  writeFileSync(staleAudio, 'fixture');
  const stat = statSync(audio, { bigint: true });
  const staleStat = statSync(staleAudio, { bigint: true });
  const source = join(dir, 'source.sqlite');
  const target = join(dir, 'index.sqlite');
  const manifest = join(dir, 'manifest.json');
  const models = { fixture: { sha256: 'fixture' } };
  writeFileSync(manifest, JSON.stringify({ models }));
  const db = new Database(source);
  db.exec(`
    CREATE TABLE source_inventory(track_id TEXT PRIMARY KEY,source_path TEXT,nav_missing INTEGER,path_status TEXT);
    CREATE TABLE track_analysis(analysis_id INTEGER PRIMARY KEY,track_id TEXT,source_size INTEGER,source_mtime_ns INTEGER,status TEXT,summary_json TEXT,run_id TEXT);
    CREATE TABLE analysis_run(run_id TEXT PRIMARY KEY,code_version TEXT,provenance_json TEXT);
    CREATE TABLE track_segment(segment_id INTEGER PRIMARY KEY,analysis_id INTEGER,start_ms INTEGER,end_ms INTEGER,role TEXT,measurements_json TEXT,quality_json TEXT);
    CREATE TABLE model_prediction(segment_id INTEGER,model_id TEXT,class_name TEXT,raw_score REAL,native_scale TEXT,missing_reason TEXT,PRIMARY KEY(segment_id,model_id,class_name));
  `);
  const provenance = { models, sample_rate: 16000, window_policy: 'up to five non-overlapping 10s windows: start, quartiles, end',
    inference_aggregation: 'mean over model patches per segment' };
  db.prepare('INSERT INTO analysis_run VALUES(?,?,?)').run('run', 'essentia-window-v1', JSON.stringify(provenance));
  const inventory = db.prepare('INSERT INTO source_inventory VALUES(?,?,0,?)');
  const analysis = db.prepare('INSERT INTO track_analysis VALUES(?,?,?,?,?,?,?)');
  const segment = db.prepare('INSERT INTO track_segment VALUES(?,?,?,?,?,?,?)');
  const prediction = db.prepare('INSERT INTO model_prediction VALUES(?,?,?,?,?,?)');
  db.transaction(() => {
    for (let i = 1; i <= 264; i++) {
      const id = i === 260 ? 'rare-piano' : i === 261 ? 'partial' : i === 262 ? 'stale'
        : i >= 263 ? 'ambiguous' : `lead-${String(i).padStart(3, '0')}`;
      const file = i === 262 ? staleAudio : audio;
      const fileStat = i === 262 ? staleStat : stat;
      if (i !== 264) inventory.run(id, file, 'mapped');
      analysis.run(i, id, fileStat.size, fileStat.mtimeNs, 'complete', '{"segments":1}', 'run');
      segment.run(i, i, 0, 10000, 'opening', '{}', '{}');
      prediction.run(i, 'deam-msd-musicnn-2', 'arousal', i === 260 ? 2 : 1.1, 'DEAM native [1,9], valence then arousal', null);
      if (i !== 261) {
        prediction.run(i, 'voice_instrumental-discogs-effnet-1', 'voice', i >= 260 ? 0.1 : 0.9, 'model native; see metadata', null);
        prediction.run(i, 'mtg_jamendo_instrument-discogs-effnet-1', 'piano', i >= 260 ? 0.9 : 0.01, 'model native; see metadata', null);
      }
    }
  })();
  db.close();
  for (let i = 0; i < 3; i++) {
    execFileSync('python3', ['scripts/music-evidence-index-v2.py', '--source', source, '--index', target,
      '--models-manifest', manifest, '--limit', '100'], { cwd: resolve('.') });
  }
  writeFileSync(staleAudio, 'stale fixture has changed');
  const socketDir = join(dir, 'socket');
  execFileSync('mkdir', [socketDir]);
  const server = spawn(process.execPath, ['src/music/essentia-socket-server.mjs', socketDir, target, source, target], { cwd: resolve('.') });
  try {
    for (let i = 0; i < 100 && !existsSync(join(socketDir, 'evidence.sock')); i++) await new Promise(r => setTimeout(r, 20));
    const preferences = [
      { family: 'arousal' as const, key: 'value', direction: 'low' as const },
      { family: 'voice' as const, key: 'value', direction: 'low' as const },
      { family: 'instrument' as const, key: 'piano', direction: 'high' as const },
    ];
    const result = await searchJointSocket(join(socketDir, 'evidence.sock'), { preferences, limit: 2 });
    assert.ok(result);
    assert.equal(result.rankedCount, 262);
    assert.equal(result.results[0].id, 'rare-piano');
    assert.equal(result.results[0].tier, 'full');
    assert.equal(result.results[0].evidenceCoverage, 1);
    assert.equal(result.rejectedFreshness, 1);
    console.log('socket fixture:', JSON.stringify(result));
    const scope = await searchJointSocket(join(socketDir, 'evidence.sock'), {
      preferences, eligibleIds: ['rare-piano', 'partial', 'stale', 'ambiguous'], limit: 4,
    });
    assert.deepEqual(scope?.results.map(x => [x.id, x.tier]), [['rare-piano', 'full'], ['partial', 'partial']]);
    assert.equal(scope?.rejectedFreshness, 1);
    const required = await searchJointSocket(join(socketDir, 'evidence.sock'), {
      preferences, eligibleIds: ['partial'], requiredFamilies: ['instrument'],
    });
    assert.deepEqual(required?.results, []);
    const invalid = await searchJointSocket(join(socketDir, 'evidence.sock'), {
      preferences: [{ family: 'instrument', key: '../invalid', direction: 'high' }],
    });
    assert.equal(invalid, null);
    assert.equal(await searchJointSocket(join(dir, 'missing.sock'), { preferences }), null);
  } finally {
    server.kill('SIGTERM');
  }
});

test('v2 socket client enforces its absolute deadline', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'music-v2-timeout-'));
  const socketPath = join(dir, 'hang.sock');
  const server = createServer(socket => socket.on('error', () => {}));
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    const start = Date.now();
    const result = await searchJointSocket(socketPath, {
      preferences: [{ family: 'arousal', key: 'value', direction: 'low' }],
    });
    assert.equal(result, null);
    assert.ok(Date.now() - start < 2000);
  } finally {
    server.close();
  }
});
