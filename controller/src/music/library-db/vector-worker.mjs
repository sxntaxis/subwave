// Native SQLite searches run here, never on Express's event loop. Each job gets
// a fresh read-only connection so a library restore cannot leave a cached inode.
import { parentPort } from 'node:worker_threads';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { queryKnn } from './knn-query.mjs';

parentPort.on('message', job => {
  let database;
  try {
    database = new Database(job.path, { readonly: true, fileMustExist: true });
    sqliteVec.load(database);
    const buffer = job.seed != null
      ? database.prepare(`SELECT embedding FROM ${job.table} WHERE id = ?`).get(job.seed)?.embedding
      : Buffer.from(new Float32Array(job.vector).buffer);
    const hits = buffer ? queryKnn(database, buffer, job.k, job.seed, job.table, new Set(job.excludeIds)) : [];
    parentPort.postMessage({ id: job.id, hits });
  } catch (error) {
    parentPort.postMessage({ id: job.id, error: error.message });
  } finally {
    database?.close();
  }
});
