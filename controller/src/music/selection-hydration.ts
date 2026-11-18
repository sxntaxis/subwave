// Attempt-local bounds and cache. Actual read functions are injected so this
// module cannot open a database or change station state by itself.
import type { AcousticEvidence } from './selection-score.js';

export interface AcousticRead {
  metadata(id: string): Omit<AcousticEvidence, 'vector'> | null;
  vector(id: string): ArrayLike<number> | null;
}
export interface HydrationMetrics {
  candidateIds: number;
  contextIds: number;
  metadataReads: number;
  vectorReads: number;
  elapsedMs: number;
  budgetMisses: number;
}

export function createSelectionHydrator(read: AcousticRead, clock: () => number = () => performance.now()) {
  const cache = new Map<string, AcousticEvidence | null>();
  const metrics: HydrationMetrics = { candidateIds: 0, contextIds: 0, metadataReads: 0, vectorReads: 0, elapsedMs: 0, budgetMisses: 0 };

  function get(id: string | null | undefined, role: 'candidate' | 'context'): AcousticEvidence | null {
    if (!id) return null;
    if (cache.has(id)) return cache.get(id) ?? null;
    const key = role === 'candidate' ? 'candidateIds' : 'contextIds';
    const ceiling = role === 'candidate' ? 256 : 6;
    if (metrics[key] >= ceiling) { metrics.budgetMisses++; return null; }
    metrics[key]++;
    const start = clock();
    let metadata: Omit<AcousticEvidence, 'vector'> | null = null;
    let vector: ArrayLike<number> | null = null;
    try { metrics.metadataReads++; metadata = read.metadata(id); } catch { /* missing evidence */ }
    try { metrics.vectorReads++; vector = read.vector(id); } catch { /* missing evidence */ }
    metrics.elapsedMs += Math.max(0, clock() - start);
    const value = metadata || vector ? { ...(metadata ?? {}), vector } : null;
    cache.set(id, value);
    return value;
  }
  return { get, metrics };
}
