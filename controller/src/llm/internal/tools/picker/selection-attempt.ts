// Attempt-local coordination for the experimental picker. This module does
// not construct an index or perform database reads; its caller supplies the
// asynchronous lookup. In particular it is not used by the request agent.

export const SELECTION_WAIT_MS = 750;
export const SELECTION_CANDIDATE_IDS = 256;
export const SELECTION_CONTEXT_IDS = 6;

export interface SelectionLookup<T> {
  (ids: readonly string[], timeoutMs: number): Promise<T | null>;
}

export type SelectionLookupReason =
  | 'available' | 'deadline_or_budget' | 'candidate_ceiling'
  | 'no_eligible_context' | 'index_unavailable';

export interface SelectionLookupResult<T> {
  rows: T | null;
  reason: SelectionLookupReason;
  elapsedMs: number;
}

/**
 * Serialize the whole eligibility-to-commit transaction, not merely the lookup:
 * two overlapping discovery tools must not both decide that an id is unseen.
 */
export function createSelectionAttempt() {
  let tail: Promise<void> = Promise.resolve();
  let remainingMs = SELECTION_WAIT_MS;
  const candidateIds = new Set<string>();
  const contextIds = new Set<string>();

  function transaction<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function lookupObserved<T>(
    candidates: readonly string[],
    context: readonly string[],
    read: SelectionLookup<T>,
  ): Promise<SelectionLookupResult<T>> {
    const uniqueCandidates = [...new Set(candidates)];
    const uniqueContext = [...new Set(context)];
    if (remainingMs <= 0 || new Set([...contextIds, ...uniqueContext]).size > SELECTION_CONTEXT_IDS) {
      return { rows: null, reason: 'deadline_or_budget', elapsedMs: 0 };
    }
    if (uniqueCandidates.some(id => !id) || uniqueContext.some(id => !id) || !uniqueCandidates.length) {
      return { rows: null, reason: 'no_eligible_context', elapsedMs: 0 };
    }
    const combined = new Set([...candidateIds, ...uniqueCandidates]);
    if (combined.size > SELECTION_CANDIDATE_IDS) return { rows: null, reason: 'candidate_ceiling', elapsedMs: 0 };
    const ids = [...new Set([...uniqueCandidates, ...uniqueContext])];
    if (!ids.length) return { rows: null, reason: 'no_eligible_context', elapsedMs: 0 };
    for (const id of uniqueCandidates) candidateIds.add(id);
    for (const id of uniqueContext) contextIds.add(id);

    const start = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let rows: T | null = null;
    try {
      rows = await Promise.race([
        Promise.resolve().then(() => read(ids, Math.ceil(remainingMs))),
        new Promise<null>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(null); }, remainingMs); }),
      ]);
    } catch {
      rows = null;
    } finally {
      if (timer) clearTimeout(timer);
      remainingMs = timedOut ? 0 : Math.max(0, remainingMs - (performance.now() - start));
    }
    const elapsedMs = Math.min(SELECTION_WAIT_MS, Math.max(0, performance.now() - start));
    return {
      rows,
      reason: rows ? 'available' : timedOut ? 'deadline_or_budget' : 'index_unavailable',
      elapsedMs,
    };
  }

  async function lookup<T>(
    candidates: readonly string[],
    context: readonly string[],
    read: SelectionLookup<T>,
  ): Promise<T | null> {
    return (await lookupObserved(candidates, context, read)).rows;
  }

  return { transaction, lookup, lookupObserved };
}
