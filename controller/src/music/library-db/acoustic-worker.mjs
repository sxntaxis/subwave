// Private v1 acoustic batch protocol. All SQLite work stays off the main thread.
import { parentPort } from 'node:worker_threads';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

parentPort.on('message', job => {
  let db;
  try {
    if (job?.version !== 1 || typeof job.path !== 'string' || !Array.isArray(job.ids)
      || job.ids.length > 262 || job.ids.some(id => typeof id !== 'string' || !id || id.length > 256)
      || new Set(job.ids).size !== job.ids.length) throw new Error('invalid acoustic batch');
    db = new Database(job.path, { readonly: true, fileMustExist: true });
    sqliteVec.load(db);
    const meta = db.prepare('SELECT bpm, musical_key, pace_json, key_ranges_json, duration_sec FROM tracks WHERE id=?');
    const vector = db.prepare('SELECT embedding FROM track_audio_vectors WHERE id=?');
    const rows = [];
    let bytes = 0;
    for (const id of job.ids) {
      const track = meta.get(id);
      const embedding = vector.get(id)?.embedding;
      let audio = null;
      if (embedding && embedding.length === 512 * 4) {
        audio = Array.from(new Float32Array(embedding.buffer, embedding.byteOffset, 512));
        bytes += embedding.length;
      }
      bytes += Buffer.byteLength(track?.pace_json ?? '') + Buffer.byteLength(track?.key_ranges_json ?? '');
      rows.push({ id, track: track ?? null, vector: audio });
    }
    parentPort.postMessage({ version: 1, rows, queries: job.ids.length * 2, bytes });
  } catch {
    parentPort.postMessage({ version: 1, error: 'acoustic batch failed' });
  } finally {
    db?.close();
  }
});
