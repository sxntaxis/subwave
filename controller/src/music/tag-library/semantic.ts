import * as db from '../library-db.js';
import * as coyote from '../../coyote/client.js';
import { SEMANTIC_MODEL, SEMANTIC_PROMPT_HASH, SEMANTIC_MOOD_IDS, SEMANTIC_SOURCE } from '../semantic/contract-v2.js';
import type { WalkedSongLocator } from './flags.js';
import { reportProgress } from '../tagger-progress.js';
import { logEvent } from './log.js';

export interface SemanticTagStats {
  processed: number;
  labels: number;
  none: number;
  unresolved: number;
  reused: number;
  providerGenerations: number;
  failures: number;
}

function orderedMoods(values: string[]): string[] {
  const present = new Set(values);
  return SEMANTIC_MOOD_IDS.filter(mood => present.has(mood));
}

function currentProvenance() {
  return { source: SEMANTIC_SOURCE, promptHash: SEMANTIC_PROMPT_HASH, model: SEMANTIC_MODEL };
}

export async function semanticTagIds(
  ids: string[],
  songs: Map<string, WalkedSongLocator>,
): Promise<SemanticTagStats> {
  const stats: SemanticTagStats = {
    processed: 0, labels: 0, none: 0, unresolved: 0, reused: 0, providerGenerations: 0, failures: 0,
  };
  reportProgress({
    phase: 'semantic',
    label: 'Canonical semantic mood tagging',
    done: 0,
    total: ids.length,
    semantic: { labels: 0, none: 0, unresolved: 0, reused: 0, providerGenerations: 0, failures: 0 },
  });

  for (const id of ids) {
    const song = songs.get(id);
    if (!song) {
      stats.failures += 1;
      logEvent('warning', `Semantic mood tagging skipped ${id}: locator was not present in the live walk`);
      continue;
    }
    try {
      const result = await coyote.semanticRetag(coyote.locatorFromSong(song));
      if (result.reused) stats.reused += 1;
      if (!result.reused && ['SEMANTIC_LABELS', 'SEMANTIC_NONE', 'UNRESOLVED_INSUFFICIENT_EVIDENCE'].includes(result.outcome)) {
        stats.providerGenerations += 1;
      }

      if (result.outcome === 'SEMANTIC_LABELS' || result.outcome === 'SEMANTIC_NONE') {
        const moods = orderedMoods(result.moods || []);
        const energy = db.getTrack(id)?.energy ?? null;
        db.upsertTrackTags(id, {
          moods,
          energy,
          source: SEMANTIC_SOURCE,
          confidence: null,
          promptHash: SEMANTIC_PROMPT_HASH,
          model: SEMANTIC_MODEL,
        });
        if (moods.length) stats.labels += 1;
        else stats.none += 1;
      } else if (result.outcome === 'UNRESOLVED_INSUFFICIENT_EVIDENCE') {
        // Current unresolved is durable completion for routine restart scope,
        // but it never creates an editorial MOOD value or coverage label.
        const energy = db.getTrack(id)?.energy ?? null;
        db.upsertTrackTags(id, {
          moods: [],
          energy,
          source: SEMANTIC_SOURCE,
          confidence: null,
          promptHash: SEMANTIC_PROMPT_HASH,
          model: SEMANTIC_MODEL,
        });
        stats.unresolved += 1;
      } else {
        stats.failures += 1;
        logEvent('warning', `Semantic mood tagging failed for ${id}: ${result.outcome}`);
      }
    } catch (err: any) {
      stats.failures += 1;
      logEvent('warning', `Semantic mood tagging failed for ${id}: ${err?.message || err}`);
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
  }
  return stats;
}
