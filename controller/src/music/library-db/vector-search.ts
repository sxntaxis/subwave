import { Worker } from 'node:worker_threads';
import { getDbNonce, requireDb } from './handle.js';
import type { KnnHit, KnnOpts } from './vectors.js';

interface Pending {
  resolve: (hits: KnnHit[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  nonce: string;
}

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<number, Pending>();

export function closeVectorSearch(error = new Error('Vector search interrupted')): void {
  const previous = worker;
  worker = null;
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(error);
  }
  pending.clear();
  void previous?.terminate();
}

function searchWorker(): Worker {
  if (worker) return worker;
  const next = new Worker(new URL('./vector-worker.mjs', import.meta.url), {
    // Native-JS entrypoint: do not inherit tsx's loader/preflight hooks or the
    // parent CLI's --input-type flag. Node 22 can stall during nested loader boot.
    execArgv: [],
  });
  worker = next;
  next.on('message', (message: { id: number; hits?: KnnHit[]; error?: string }) => {
    if (worker !== next) return;
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    clearTimeout(job.timer);
    if (message.error) job.reject(new Error(message.error));
    else job.resolve(job.nonce === getDbNonce() ? message.hits ?? [] : []);
    if (!pending.size) next.unref();
  });
  next.on('error', error => { if (worker === next) closeVectorSearch(error instanceof Error ? error : new Error(String(error))); });
  next.on('exit', () => { if (worker === next) closeVectorSearch(); });
  next.unref();
  return next;
}

export function searchKnnAsync(
  table: 'track_vectors' | 'track_audio_vectors',
  query: string | number[] | Float32Array,
  k: number,
  opts: KnnOpts = {},
): Promise<KnnHit[]> {
  const path = requireDb().name;
  if (pending.size >= 32) return Promise.reject(new Error('Vector search is busy'));
  const next = searchWorker();
  next.ref();
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => closeVectorSearch(), 45_000);
    pending.set(id, { resolve, reject, timer, nonce: getDbNonce() });
    next.postMessage({
      id, path, table, k,
      seed: typeof query === 'string' ? query : null,
      vector: typeof query === 'string' ? null : Array.from(query),
      excludeIds: [...opts.excludeIds ?? []],
    });
  });
}
