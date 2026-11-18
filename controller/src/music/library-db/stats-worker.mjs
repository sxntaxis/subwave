// Native JavaScript: do not inherit tsx loader hooks into Node 22 workers.
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { computeLibraryStats } from './stats-query.mjs';

let database;
try {
  database = new Database(workerData.path, { readonly: true, fileMustExist: true });
  sqliteVec.load(database);
  const value = computeLibraryStats(database, workerData.hasMoods);
  parentPort.postMessage({ value });
} catch (error) {
  parentPort.postMessage({ error: error.message });
} finally {
  database?.close();
}
