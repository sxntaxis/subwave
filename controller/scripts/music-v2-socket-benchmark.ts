// Disposable 28k-record socket benchmark. Never touches a production database.
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { searchJointSocket, type JointEvidencePreference } from '../src/music/essentia-evidence.js';

const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'music-v2-bench-'));
const audio = join(dir, 'fixture.audio');
writeFileSync(audio, 'synthetic');
const st = statSync(audio, { bigint: true });
const models = { fixture: { sha256: 'fixture' } };
const modelsHash = createHash('sha256').update(JSON.stringify(models)).digest('hex');
const provenance = JSON.stringify({
  models, sample_rate: 16000, window_policy: 'up to five non-overlapping 10s windows: start, quartiles, end',
  inference_aggregation: 'mean over model patches per segment',
});
const srcPath = join(dir, 'source.sqlite');
const indexPath = join(dir, 'index.sqlite');
const src = new Database(srcPath);
src.exec(`
  CREATE TABLE source_inventory(track_id TEXT PRIMARY KEY,source_path TEXT,nav_missing INTEGER,path_status TEXT);
  CREATE TABLE track_analysis(analysis_id INTEGER PRIMARY KEY,track_id TEXT,source_size INTEGER,source_mtime_ns INTEGER,status TEXT,summary_json TEXT,run_id TEXT);
  CREATE TABLE analysis_run(run_id TEXT PRIMARY KEY,code_version TEXT,provenance_json TEXT);
`);
src.prepare('INSERT INTO analysis_run VALUES(?,?,?)').run('run', 'essentia-window-v1', provenance);
const index = new Database(indexPath);
index.exec(`
  CREATE TABLE contract(id INTEGER PRIMARY KEY,version INTEGER,models_sha256 TEXT);
  CREATE TABLE evidence(analysis_id INTEGER PRIMARY KEY,track_id TEXT,run_id TEXT,source_path TEXT,source_size INTEGER,source_mtime_ns INTEGER,expected_windows INTEGER,indexed_windows INTEGER,provenance_json TEXT,ready INTEGER);
  CREATE INDEX evidence_identity ON evidence(track_id,ready);
  CREATE TABLE windows(segment_id INTEGER PRIMARY KEY,analysis_id INTEGER,start_ms INTEGER,end_ms INTEGER,role TEXT,measurements_json TEXT,quality_json TEXT);
  CREATE INDEX windows_analysis ON windows(analysis_id,start_ms);
  CREATE TABLE outputs(segment_id INTEGER,model_id TEXT,class_name TEXT,raw_score REAL,native_scale TEXT,missing_reason TEXT,validity TEXT);
  CREATE INDEX outputs_segment ON outputs(segment_id);
  CREATE TABLE head_summary(analysis_id INTEGER,model_id TEXT,class_name TEXT,mean REAL,minimum REAL,maximum REAL,valid_windows INTEGER,expected_windows INTEGER,PRIMARY KEY(analysis_id,model_id,class_name));
  CREATE INDEX head_summary_search ON head_summary(model_id,class_name,analysis_id);
`);
index.prepare('INSERT INTO contract VALUES(1,3,?)').run(modelsHash);
const inventory = src.prepare('INSERT INTO source_inventory VALUES(?,?,0,?)');
const analysis = src.prepare('INSERT INTO track_analysis VALUES(?,?,?,?,?,?,?)');
const evidence = index.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?,?)');
const window = index.prepare('INSERT INTO windows VALUES(?,?,?,?,?,?,?)');
const summary = index.prepare('INSERT INTO head_summary VALUES(?,?,?,?,?,?,?,?)');
const heads: Array<[string, string, number]> = [
  ['deam-msd-musicnn-2', 'arousal', 4], ['deam-msd-musicnn-2', 'valence', 6],
  ['voice_instrumental-discogs-effnet-1', 'voice', .3], ['danceability-discogs-effnet-1', 'danceable', .4],
  ['timbre-discogs-effnet-1', 'bright', .5], ['engagement_regression-discogs-effnet-1', 'engagement', .6],
  ['approachability_regression-discogs-effnet-1', 'approachability', .2],
  ...['piano', 'drums', 'bass', 'synthesizer', 'guitar', 'strings', 'saxophone', 'keyboard'].map(label =>
    ['mtg_jamendo_instrument-discogs-effnet-1', label, .4] as [string, string, number]),
  ...['calm', 'dark', 'energetic', 'happy', 'sad', 'upbeat', 'relaxing', 'melancholic'].map(label =>
    ['mtg_jamendo_moodtheme-discogs-effnet-1', label, .4] as [string, string, number]),
];
src.exec('BEGIN');
index.exec('BEGIN');
for (let i = 1; i <= 28000; i++) {
  const id = `track-${String(i).padStart(5, '0')}`;
  inventory.run(id, audio, 'mapped');
  analysis.run(i, id, st.size, st.mtimeNs, 'complete', '{"segments":1}', 'run');
  evidence.run(i, id, 'run', audio, st.size, st.mtimeNs, 1, 1, provenance, 1);
  window.run(i, i, 0, 10000, 'opening', '{}', '{}');
  for (const [model, label, value] of heads) {
    summary.run(i, model, label, value, value, value, 1, 1);
  }
}
src.exec('COMMIT');
index.exec('COMMIT');
src.close();
index.close();
writeFileSync(`${indexPath}.ready`, JSON.stringify({ version: 3, ready: true, models_sha256: modelsHash, updated_ms: Date.now() }));
const socketDir = join(dir, 'socket');
mkdirSync(socketDir);
const server = spawn(process.execPath, ['src/music/essentia-socket-server.mjs', socketDir, indexPath, srcPath, indexPath], { cwd: resolve('.') });
const socket = join(socketDir, 'evidence.sock');
const cases: Record<string, JointEvidencePreference[]> = {
  one: [{ family: 'arousal', key: 'value', direction: 'low' }],
  three: [
    { family: 'arousal', key: 'value', direction: 'low' },
    { family: 'voice', key: 'value', direction: 'low' },
    { family: 'instrument', key: 'piano', direction: 'high' },
  ],
  rich: [
    { family: 'arousal', key: 'value', direction: 'low' },
    { family: 'valence', key: 'value', direction: 'high' },
    { family: 'voice', key: 'value', direction: 'low' },
    { family: 'instrument', key: 'piano', direction: 'high' },
    { family: 'instrument', key: 'drums', direction: 'high' },
    { family: 'mood', key: 'calm', direction: 'high' },
  ],
};
try {
  for (let i = 0; i < 200 && !existsSync(socket); i++) await new Promise(r => setTimeout(r, 20));
  if (!existsSync(socket)) throw Error('socket did not start');
  for (const [name, preferences] of Object.entries(cases)) {
    for (const mode of ['cold', 'warm', 'loaded']) {
      const load = mode === 'loaded' ? new Worker('const end=Date.now()+2000;while(Date.now()<end){}', { eval: true }) : null;
      const start = performance.now();
      const result = await searchJointSocket(socket, { preferences, limit: 8 });
      const elapsed = Math.round(performance.now() - start);
      console.log(JSON.stringify({ name, mode, elapsedMs: elapsed, success: result !== null,
        rankedCount: result?.rankedCount ?? null, returned: result?.results.length ?? null,
        clientRssMiB: Math.round(process.memoryUsage().rss / 1048576) }));
      await load?.terminate();
    }
  }
} finally {
  server.kill('SIGTERM');
}
