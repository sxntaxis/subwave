// Greedy composition over candidates whose eligibility was already resolved.
// This module neither filters show policy nor queries a catalogue.
import { acousticSimilarity, type AcousticEvidence } from './selection-score.js';

export interface RankedCandidate<T> {
  value: T;
  id: string;
  artistKey: string;
  baselineIndex: number;
  utility: number;
  acoustic: AcousticEvidence | null;
}

/** Stable bounded MMR; unknown vectors carry no redundancy penalty. */
export function composeSelection<T>(
  candidates: readonly RankedCandidate<T>[],
  cap: number,
  maxPerArtist: number,
): T[] {
  const chosen: RankedCandidate<T>[] = [];
  const seen = new Set<string>();
  const artists = new Map<string, number>();
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : candidates.length;
  while (chosen.length < limit) {
    let best: RankedCandidate<T> | null = null;
    let bestScore = -Infinity;
    for (const item of candidates) {
      if (!item.id || seen.has(item.id)) continue;
      if (item.artistKey && (artists.get(item.artistKey) ?? 0) >= maxPerArtist) continue;
      let redundancy = 0;
      for (const prev of chosen) {
        const similarity = acousticSimilarity(item.acoustic?.vector, prev.acoustic?.vector);
        if (similarity != null) redundancy = Math.max(redundancy, similarity);
      }
      const utility = Number.isFinite(item.utility) ? Math.max(0, Math.min(1, item.utility)) : 0;
      const score = utility - 0.1 * redundancy;
      if (!best || score > bestScore || (score === bestScore
        && (item.baselineIndex < best.baselineIndex
          || (item.baselineIndex === best.baselineIndex && item.id < best.id)))) {
        best = item;
        bestScore = score;
      }
    }
    if (!best) break;
    chosen.push(best);
    seen.add(best.id);
    if (best.artistKey) artists.set(best.artistKey, (artists.get(best.artistKey) ?? 0) + 1);
  }
  return chosen.map(item => item.value);
}
