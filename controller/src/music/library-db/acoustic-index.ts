// Lazy private child process. No process or database read is started until a
// caller explicitly constructs an index for an enabled selection path.
import { fork, type ChildProcess } from 'node:child_process';
import { getDbNonce, requireDb } from './handle.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const probeScope = new AsyncLocalStorage<{ starts: number; lookups: number }>();
export function withAcousticProbeForTest<T>(probe: { starts: number; lookups: number }, fn: () => T): T {
  return probeScope.run(probe, fn);
}

export interface IndexedAcousticRow {
  id: string;
  track: { bpm: number | null; musical_key: string | null; pace_json: string | null;
    key_ranges_json: string | null; duration_sec: number | null } | null;
  vector: Float32Array | null;
}
export interface IndexMetrics {
  ready: boolean;
  metadataRows: number;
  vectorRows: number;
  invalidRows: number;
  vectorBytes: number;
  openMs: number;
  metadataMs: number;
  vectorMs: number;
  rssBytes: number;
}
type Pending = { resolve: (rows: IndexedAcousticRow[] | null) => void; timer: ReturnType<typeof setTimeout>; expired: boolean };

export function createAcousticIndex(path: string) {
  const probe = probeScope.getStore();
  if (probe) probe.starts++;
  const metrics: IndexMetrics = { ready: false, metadataRows: 0, vectorRows: 0, invalidRows: 0,
    vectorBytes: 0, openMs: 0, metadataMs: 0, vectorMs: 0, rssBytes: 0 };
  const pending = new Map<number, Pending>();
  const readyWaiters = new Set<(ready: boolean) => void>();
  let child: ChildProcess | null = null;
  let nextId = 0, closed = false, failed = false;
  function finishAll() {
    for (const p of pending.values()) { clearTimeout(p.timer); p.resolve(null); }
    pending.clear();
  }
  function close() {
    closed = true; metrics.ready = false; finishAll();
    for (const waiter of readyWaiters) waiter(false);
    readyWaiters.clear();
    const previous = child; child = null;
    if (previous?.connected) previous.disconnect();
    previous?.kill();
  }
  try {
    const process = fork(new URL('./acoustic-index-worker.mjs', import.meta.url), [], {
      execArgv: ['--max-old-space-size=160'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
    });
    child = process;
    process.unref();
    process.channel?.unref();
    process.on('message', (message: any) => {
      if (closed || message?.version !== 1) return;
      if (message.type === 'ready') {
        Object.assign(metrics, { ready: true, metadataRows: message.metaRows, vectorRows: message.vectorRows,
          invalidRows: message.invalidRows, vectorBytes: message.vectorBytes, openMs: message.openMs,
          metadataMs: message.metadataMs, vectorMs: message.vectorMs, rssBytes: message.rssBytes });
        for (const waiter of readyWaiters) waiter(true);
        readyWaiters.clear();
        return;
      }
      if (message.type === 'stale' || message.type === 'unavailable') metrics.ready = false;
      if (message.type === 'unavailable') {
        failed = true;
        finishAll();
        process.kill();
        return;
      }
      const p = pending.get(message.requestId);
      if (!p) return;
      pending.delete(message.requestId); clearTimeout(p.timer);
      if (!p.expired) p.resolve(message.type === 'result' && Array.isArray(message.rows) ? message.rows : null);
    });
    process.on('error', () => { if (!closed) failed = true; metrics.ready = false; finishAll(); });
    process.on('exit', () => { if (!closed) failed = true; metrics.ready = false; child = null; finishAll(); });
    process.send({ version: 1, type: 'warm', path });
  } catch { metrics.ready = false; failed = true; }
  function lookup(ids: readonly string[], timeoutMs: number): Promise<IndexedAcousticRow[] | null> {
    if (closed || !child?.connected || !metrics.ready || pending.size >= 8 || timeoutMs <= 0
      || !ids.length || ids.length > 262 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !id || id.length > 256)) return Promise.resolve(null);
    const process = child;
    return new Promise(resolve => {
      const requestId = ++nextId;
      // A timeout resolves the caller but does not free the mailbox slot. The
      // child may still be processing it; retaining the slot bounds actual IPC
      // work, not merely the number of callers still waiting for a result.
      const timer = setTimeout(() => {
        const p = pending.get(requestId);
        if (p && !p.expired) { p.expired = true; resolve(null); }
      }, timeoutMs);
      pending.set(requestId, { resolve, timer, expired: false });
      process.send({ version: 1, type: 'lookup', requestId, ids }, error => {
        if (!error) return;
        const p = pending.get(requestId);
        if (p) { pending.delete(requestId); clearTimeout(p.timer); if (!p.expired) p.resolve(null); }
      });
    });
  }
  function whenReady(timeoutMs: number): Promise<boolean> {
    if (metrics.ready) return Promise.resolve(true);
    if (closed || !child || timeoutMs <= 0) return Promise.resolve(false);
    return new Promise(resolve => {
      const waiter = (ready: boolean) => { clearTimeout(timer); readyWaiters.delete(waiter); resolve(ready); };
      const timer = setTimeout(() => waiter(false), timeoutMs);
      readyWaiters.add(waiter);
    });
  }
  return { lookup, close, metrics, whenReady, isFailed: () => failed || closed };
}

let shared: ReturnType<typeof createAcousticIndex> | null = null;
let sharedNonce: string | null = null;
let failures = 0, retryAt = 0;
const retryDelays = [5_000, 30_000, 120_000];
export function getSharedAcousticIndex() {
  const probe = probeScope.getStore();
  if (probe) probe.lookups++;
  const nonce = getDbNonce();
  if (shared && sharedNonce !== nonce) {
    shared.close(); shared = null; failures = 0; retryAt = 0;
  }
  if (shared?.metrics.ready) { failures = 0; retryAt = 0; }
  if (shared?.isFailed()) {
    shared.close(); shared = null;
    retryAt = Date.now() + retryDelays[Math.min(failures++, retryDelays.length - 1)];
  }
  if (!shared && Date.now() < retryAt) return null;
  if (!shared) { shared = createAcousticIndex(requireDb().name); sharedNonce = nonce; }
  return shared;
}
export function closeAcousticIndex() {
  shared?.close(); shared = null; sharedNonce = null; failures = 0; retryAt = 0;
}
