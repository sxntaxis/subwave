// Library-wide counts for the admin dashboard, cached because the aggregate scan
// is the most expensive read in this module.

import { Worker } from 'node:worker_threads';
import { DB_PATH, SQL_HAS_MOODS, getDb, getDbNonce, requireDb } from './handle.js';
import type { LibraryStats } from './types.js';
import { computeLibraryStats } from './stats-query.mjs';

// ~7 full-table scans, polled from several admin pages; uncached it blocks
// listener polls on the synchronous DB thread (#723).
let statsCache: { at: number; value: LibraryStats } | null = null;
const STATS_TTL_MS = 5000;
let statsNonce = '';
let pendingStats: { promise: Promise<LibraryStats>; cancel: () => void } | null = null;
let retryStatsAt = 0;

/** One bounded read-only job; refreshes never queue behind each other. */
export function warmStats(): Promise<LibraryStats> {
  if (pendingStats) return pendingStats.promise;
  const nonce = getDbNonce();
  let worker: Worker;
  try {
    worker = new Worker(new URL('./stats-worker.mjs', import.meta.url), {
      workerData: { path: DB_PATH, hasMoods: SQL_HAS_MOODS }, execArgv: [],
    });
  } catch (error) { return Promise.reject(error); }
  let cancel = () => {};
  const promise = new Promise<LibraryStats>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: LibraryStats) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingStats?.promise === promise) pendingStats = null;
      void worker.terminate();
      if (error) reject(error);
      else if (nonce !== getDbNonce()) reject(new Error('Library changed during stats refresh'));
      else {
        statsCache = { at: Date.now(), value: value! };
        statsNonce = nonce;
        resolve(value!);
      }
    };
    const timer = setTimeout(() => finish(new Error('Library stats refresh exceeded 60s')), 60_000);
    timer.unref();
    cancel = () => finish(new Error('Library stats refresh invalidated'));
    worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.value));
    worker.once('error', error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once('exit', code => { if (!settled) finish(new Error(`Stats worker exited before returning (${code})`)); });
  });
  pendingStats = { promise, cancel };
  return promise;
}

// EMBEDDED tracks whose vector carries no musical signal, only the head line
// (#1246), so similarity ranks them by artist/album wording. The five predicates
// mirror formatTrackText's optional lines and must stay in step with it. Long TTL
// because it only moves when the tagger runs and is read on a pick path
// (picker/scope.ts); invalidateStats() clears it on a handle swap.
const LABEL_ONLY_TTL_MS = 5 * 60 * 1000;
let labelOnlyCache: { at: number; value: number } | null = null;

export function labelOnlyVectorCount(): number {
  const now = Date.now();
  if (labelOnlyCache && now - labelOnlyCache.at < LABEL_ONLY_TTL_MS) return labelOnlyCache.value;
  const value = computeLabelOnlyVectorCount();
  labelOnlyCache = { at: Date.now(), value };
  return value;
}

function computeLabelOnlyVectorCount(): number {
  return (requireDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM tracks t
        WHERE EXISTS (SELECT 1 FROM track_vectors v WHERE v.id = t.id)
          AND (t.lastfm_tags   IS NULL OR t.lastfm_tags   = '' OR t.lastfm_tags   = '[]')
          AND (t.lyric_excerpt IS NULL OR t.lyric_excerpt = '')
          AND (t.audio_moods   IS NULL OR t.audio_moods   = '' OR t.audio_moods   = '[]')
          AND (t.bpm IS NULL OR t.bpm <= 0)
          AND (t.musical_key   IS NULL OR t.musical_key   = '')`,
    )
    .get() as { n: number }).n;
}

// Call on a DB handle swap so a fresh library never serves stale tallies.
export function invalidateStats(): void {
  pendingStats?.cancel();
  retryStatsAt = 0;
  if (!getDb() || statsNonce !== getDbNonce()) statsCache = null;
  else if (statsCache) statsCache.at = 0;
  labelOnlyCache = null;
}

export function stats({ backgroundOnly = false } = {}): LibraryStats {
  const now = Date.now();
  if (statsCache || backgroundOnly) {
    if ((!statsCache || now - statsCache.at >= STATS_TTL_MS) && !pendingStats && now >= retryStatsAt) {
      const nonce = getDbNonce();
      void warmStats().catch(error => {
        // Keep the last successful result and bound retry/log frequency.
        if (nonce !== getDbNonce()) return;
        retryStatsAt = Date.now() + STATS_TTL_MS;
        console.warn(`[library] stats refresh failed: ${error.message}`);
      });
    }
    return statsCache?.value ?? {
      total: 0, mirrorTotal: 0, distinctArtists: 0, byMood: {}, byEnergy: {},
      byGenre: {}, bySource: {}, withEmbedding: 0, withAudioEmbedding: 0, updatedAt: null,
    };
  }
  // Direct DB maintenance callers retain their synchronous contract. Live
  // library.load() warms the cache first and library.stats() opts out of this
  // fallback, including when that initial worker fails.
  const value = computeLibraryStats(requireDb(), SQL_HAS_MOODS) as LibraryStats;
  // Stamp AFTER the compute: it can exceed the TTL (~15s at 200k tracks), and a
  // start-of-compute stamp would expire on store.
  statsCache = { at: Date.now(), value };
  statsNonce = getDbNonce();
  return value;
}

// Opaque token that changes on any write, for the observatory ETag:
// `data_version` covers other connections (tagger/analyzer run concurrently),
// `total_changes()` this one's, the nonce handle swaps. Both reads are O(1).
export function changeToken(): string {
  const d = requireDb();
  const dataVersion = d.pragma('data_version', { simple: true }) as number;
  const ownChanges = (d.prepare('SELECT total_changes() AS c').get() as { c: number }).c;
  return `${getDbNonce()}.${dataVersion}.${ownChanges}`;
}
