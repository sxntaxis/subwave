// Private v1 acoustic index process. All SQLite and index construction happens
// here, off the controller event loop. Never write to the source database.
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const LIMIT = 256 * 1024 * 1024;
const MAX_IDS = 262;
let database = null, generation = null, index = null, warming = false;
const identity = path => {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}`;
};
const version = () => database.pragma('data_version', { simple: true });
const validVector = buffer => {
  if (!Buffer.isBuffer(buffer) || buffer.length !== 2048) return false;
  for (let offset = 0; offset < buffer.length; offset += 4) {
    if (!Number.isFinite(buffer.readFloatLE(offset))) return false;
  }
  return true;
};
function fits() {
  if (process.memoryUsage().rss > LIMIT) throw new Error('acoustic RSS limit exceeded');
}
function close() {
  index = null; generation = null;
  try { database?.close(); } catch { /* already closed */ }
  database = null;
}
function warm(path) {
  if (warming) return;
  warming = true;
  close();
  let inTransaction = false;
  try {
    const began = performance.now(), beforeIdentity = identity(path);
    database = new Database(path, { readonly: true, fileMustExist: true });
    sqliteVec.load(database);
    const opened = performance.now(), beforeVersion = version();
    database.exec('BEGIN'); inTransaction = true;
    const next = new Map();
    let metaRows = 0, vectorRows = 0, invalidRows = 0, bytes = 0;
    for (const row of database.prepare('SELECT id,bpm,musical_key,pace_json,key_ranges_json,duration_sec FROM tracks').iterate()) {
      if (typeof row.id !== 'string' || !row.id || next.has(row.id)) throw new Error('invalid or duplicate metadata ID');
      next.set(row.id, { id: row.id, track: { bpm: row.bpm, musical_key: row.musical_key,
        pace_json: row.pace_json, key_ranges_json: row.key_ranges_json, duration_sec: row.duration_sec }, vector: null });
      if (++metaRows % 64 === 0) fits();
    }
    const metadataDone = performance.now();
    for (const row of database.prepare('SELECT id,embedding FROM track_audio_vectors').iterate()) {
      const record = next.get(row.id);
      if (!record || record.vector || !validVector(row.embedding)) { invalidRows++; continue; }
      record.vector = Buffer.from(row.embedding);
      bytes += record.vector.length;
      if (++vectorRows % 64 === 0) fits();
    }
    database.exec('COMMIT'); inTransaction = false;
    fits();
    const afterVersion = version(), afterIdentity = identity(path);
    if (beforeIdentity !== afterIdentity || beforeVersion !== afterVersion) throw new Error('database changed during warmup');
    index = next;
    generation = { path, identity: afterIdentity, version: afterVersion };
    process.send?.({ version: 1, type: 'ready', metaRows, vectorRows, invalidRows, vectorBytes: bytes,
      openMs: opened-began, metadataMs: metadataDone-opened, vectorMs: performance.now()-metadataDone,
      rssBytes: process.memoryUsage().rss });
  } catch {
    if (inTransaction) { try { database?.exec('ROLLBACK'); } catch {} }
    close();
    process.send?.({ version: 1, type: 'unavailable' });
  } finally {
    warming = false;
  }
}
process.on('message', job => {
  if (job?.version !== 1) return;
  if (job.type === 'warm' && typeof job.path === 'string') { warm(job.path); return; }
  if (job.type !== 'lookup' || !Number.isSafeInteger(job.requestId) || !Array.isArray(job.ids)
    || job.ids.length > MAX_IDS || new Set(job.ids).size !== job.ids.length
    || job.ids.some(id => typeof id !== 'string' || !id || id.length > 256)) return;
  try {
    if (!index || !generation || !database || identity(generation.path) !== generation.identity || version() !== generation.version) {
      const path = generation?.path;
      close();
      process.send?.({ version: 1, type: 'stale', requestId: job.requestId });
      if (path) setImmediate(() => warm(path));
      return;
    }
    const rows = job.ids.map(id => {
      const row = index.get(id);
      let vector = null;
      if (row?.vector) {
        vector = new Float32Array(512);
        for (let i = 0; i < 512; i++) vector[i] = row.vector.readFloatLE(i * 4);
      }
      return row ? { ...row, vector } : { id, track: null, vector: null };
    });
    if (identity(generation.path) !== generation.identity || version() !== generation.version) {
      const path = generation.path;
      close();
      process.send?.({ version: 1, type: 'stale', requestId: job.requestId });
      setImmediate(() => warm(path));
      return;
    }
    // Output vectors and IPC serialization also consume resident memory.
    fits();
    process.send?.({ version: 1, type: 'result', requestId: job.requestId, rows });
  } catch {
    close();
    process.send?.({ version: 1, type: 'unavailable', requestId: job.requestId });
  }
});
process.on('disconnect', () => { close(); process.exit(0); });
