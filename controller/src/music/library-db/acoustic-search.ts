// A per-attempt, deadline-bounded worker bridge; no SQLite query runs here.
import { Worker } from 'node:worker_threads';
import { getDbNonce, requireDb } from './handle.js';

export interface AcousticRow {
  id: string;
  track: { bpm: number | null; musical_key: string | null; pace_json: string | null;
    key_ranges_json: string | null; duration_sec: number | null } | null;
  vector: number[] | null;
}
export interface AcousticBatchResult { version: 1; rows: AcousticRow[]; queries: number; bytes: number }

export function queryAcousticsInWorker(path: string, ids: string[], timeoutMs: number): Promise<AcousticBatchResult | null> {
  if (!ids.length || ids.length > 262 || timeoutMs <= 0 || ids.some(id => !id || id.length > 256)
    || new Set(ids).size !== ids.length) return Promise.resolve(null);
  return new Promise(resolve => {
    let worker: Worker;
    try { worker = new Worker(new URL('./acoustic-worker.mjs', import.meta.url), { execArgv: [] }); }
    catch { resolve(null); return; }
    let done = false;
    const finish = (value: AcousticBatchResult | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    worker.once('message', (message: AcousticBatchResult & { error?: string }) => {
      finish(message?.version === 1 && !message.error && Array.isArray(message.rows) ? message : null);
    });
    worker.once('error', () => finish(null));
    worker.once('exit', () => finish(null));
    worker.postMessage({ version: 1, path, ids });
  });
}

export function createAcousticAttempt(
  query: typeof queryAcousticsInWorker = queryAcousticsInWorker,
  clock: () => number = () => performance.now(),
  handle: () => { path: string; nonce: string } = () => ({ path: requireDb().name, nonce: getDbNonce() }),
) {
  const cache = new Map<string, AcousticRow | null>();
  const candidates = new Set<string>(), context = new Set<string>();
  let deadline: number | null = null;
  let abandoned = false;
  let busy = false;
  const metrics = { queries: 0, bytes: 0, candidateIds: 0, contextIds: 0, elapsedMs: 0, timedOut: false };
  async function hydrate(candidateIds: readonly string[], contextIds: readonly string[]): Promise<Map<string, AcousticRow | null> | null> {
    if (abandoned || busy) return null;
    const clean = (ids: readonly string[]) => [...new Set(ids.filter(id => typeof id === 'string' && !!id && id.length <= 256))];
    const c = clean(candidateIds), h = clean(contextIds);
    const newCandidates = c.filter(id => !candidates.has(id));
    const newContext = h.filter(id => !context.has(id) && !c.includes(id));
    if (c.length !== new Set(candidateIds).size || h.length !== new Set(contextIds).size
      || candidates.size + newCandidates.length > 256 || context.size + newContext.length > 6) return null;
    newCandidates.forEach(id => candidates.add(id)); newContext.forEach(id => context.add(id));
    metrics.candidateIds = candidates.size; metrics.contextIds = context.size;
    const missing = [...new Set([...c, ...h])].filter(id => !cache.has(id));
    if (!missing.length) return new Map([...c, ...h].map(id => [id, cache.get(id) ?? null]));
    const started = clock();
    deadline ??= started + 750;
    const remaining = Math.floor(deadline - started);
    if (remaining <= 0) { abandoned = true; metrics.timedOut = true; return null; }
    let path: string, nonce: string;
    try { ({ path, nonce } = handle()); } catch { abandoned = true; return null; }
    busy = true;
    let response: AcousticBatchResult | null;
    try { response = await query(path, missing, remaining); } catch { response = null; }
    busy = false;
    metrics.elapsedMs += Math.max(0, clock() - started);
    let currentNonce: string;
    try { currentNonce = handle().nonce; } catch { abandoned = true; return null; }
    if (!response || clock() > deadline || nonce !== currentNonce) {
      abandoned = true; metrics.timedOut = clock() >= deadline; return null;
    }
    if (response.rows.length !== missing.length || response.rows.some((row, i) => row.id !== missing[i])) {
      abandoned = true; return null;
    }
    metrics.queries += response.queries; metrics.bytes += response.bytes;
    response.rows.forEach(row => cache.set(row.id, row));
    return new Map([...c, ...h].map(id => [id, cache.get(id) ?? null]));
  }
  return { hydrate, metrics };
}
