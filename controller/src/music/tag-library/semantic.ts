import * as db from '../library-db.js';
import * as coyote from '../../coyote/client.js';
import { SEMANTIC_MODEL, SEMANTIC_PROMPT_HASH, SEMANTIC_MOOD_IDS, SEMANTIC_SOURCE } from '../semantic/contract-v2.js';
import type { WalkedSongLocator } from './flags.js';
import { reportProgress } from '../tagger-progress.js';
import { logEvent } from './log.js';
import { config } from '../../config.js';

export const SEMANTIC_PROVIDER_CALL_CAP = 110;

export interface SemanticTagStats {
  total: number;
  processed: number;
  labels: number;
  none: number;
  unresolved: number;
  reused: number;
  providerGenerations: number;
  failures: number;
}

type CanonicalSemanticResult = {
  outcome: 'SEMANTIC_LABELS' | 'SEMANTIC_NONE' | 'UNRESOLVED_INSUFFICIENT_EVIDENCE';
  moods?: string[];
};

function orderedMoods(values: string[]): string[] {
  const present = new Set(values);
  return SEMANTIC_MOOD_IDS.filter(mood => present.has(mood));
}

/** Persist the complete V1.21 currentness state for every durable outcome. */
export function persistCanonicalSemanticResult(id: string, result: CanonicalSemanticResult): 'labels' | 'none' | 'unresolved' {
  const moods = result.outcome === 'UNRESOLVED_INSUFFICIENT_EVIDENCE'
    ? []
    : orderedMoods(result.moods || []);
  const energy = db.getTrack(id)?.energy ?? null;
  db.upsertTrackTags(id, {
    moods,
    energy,
    source: SEMANTIC_SOURCE,
    confidence: null,
    promptHash: SEMANTIC_PROMPT_HASH,
    model: SEMANTIC_MODEL,
  });
  if (result.outcome === 'UNRESOLVED_INSUFFICIENT_EVIDENCE') return 'unresolved';
  return moods.length ? 'labels' : 'none';
}

export async function runBoundedWorkers<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
  shouldStop?: () => boolean,
): Promise<void> {
  let cursor = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted || shouldStop?.()) return;
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, run));
}

export async function semanticTagIds(
  ids: string[],
  songs: Map<string, WalkedSongLocator>,
  options: { signal?: AbortSignal; providerCallBudget?: { id: string; limit: number } } = {},
): Promise<SemanticTagStats> {
  const stats: SemanticTagStats = {
    total: ids.length,
    processed: 0, labels: 0, none: 0, unresolved: 0, reused: 0, providerGenerations: 0, failures: 0,
  };
  reportProgress({
    phase: 'semantic',
    label: 'Canonical semantic mood tagging',
    done: 0,
    total: ids.length,
    semantic: { labels: 0, none: 0, unresolved: 0, reused: 0, providerGenerations: 0, failures: 0 },
  });

  if (new Set(ids).size !== ids.length) {
    throw new Error('SEMANTIC_DUPLICATE_TRACK: cohort contains duplicate track IDs');
  }

  let providerCapLogged = false;
  let systemicTimeout = false;
  await runBoundedWorkers(ids, config.semantic.concurrency, async (id) => {
    if (systemicTimeout) return;
    const song = songs.get(id);
    if (!song) {
      stats.failures += 1;
      logEvent('warning', `Semantic mood tagging skipped ${id}: locator was not present in the live walk`);
    } else try {
        const result = await coyote.semanticRetag(coyote.locatorFromSong(song, { providerCallBudget: options.providerCallBudget }));
        if (result.reused) stats.reused += 1;
        const providerCalls = result.provider_calls;
        if (typeof providerCalls !== 'number' || !Number.isInteger(providerCalls) || providerCalls < 0) {
          throw new Error('PROVIDER_ACCOUNTING_FAILURE: Coyote did not return an exact provider_calls integer');
        }
        stats.providerGenerations += providerCalls;

        if (result.outcome === 'SEMANTIC_LABELS' || result.outcome === 'SEMANTIC_NONE' || result.outcome === 'UNRESOLVED_INSUFFICIENT_EVIDENCE') {
          const persisted = persistCanonicalSemanticResult(id, {
            outcome: result.outcome as CanonicalSemanticResult['outcome'],
            moods: result.moods,
          });
          if (persisted === 'labels') stats.labels += 1;
          else if (persisted === 'none') stats.none += 1;
          else stats.unresolved += 1;
        } else {
          stats.failures += 1;
          logEvent('warning', `Semantic mood tagging failed for ${id}: ${result.outcome}`);
        }
      } catch (err: unknown) {
        stats.failures += 1;
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof coyote.CoyoteError && err.code === 'COYOTE_TIMEOUT') {
          systemicTimeout = true;
          logEvent('error', `Semantic IPC timeout is systemic; stopping new dispatch after ${id}`);
        }
        logEvent('warning', `Semantic mood tagging failed for ${id}: ${message}`);
      }
    stats.processed += 1;
    reportProgress({
      phase: 'semantic',
      label: 'Canonical semantic mood tagging',
      done: stats.processed,
      total: ids.length,
      errors: stats.failures || undefined,
      semantic: {
        labels: stats.labels,
        none: stats.none,
        unresolved: stats.unresolved,
        reused: stats.reused,
        providerGenerations: stats.providerGenerations,
        failures: stats.failures,
      },
    });
  }, options.signal, () => {
    if (systemicTimeout) return true;
    if (stats.providerGenerations < SEMANTIC_PROVIDER_CALL_CAP) return false;
    if (!providerCapLogged) {
      providerCapLogged = true;
      logEvent('warning', `Semantic provider call cap reached (${SEMANTIC_PROVIDER_CALL_CAP}); stopping new dispatch`);
    }
    return true;
  });
  if (systemicTimeout) {
    throw new Error('SEMANTIC_RUNTIME_TIMEOUT: all dispatched operations settled; no new semantic work dispatched');
  }
  return stats;
}
