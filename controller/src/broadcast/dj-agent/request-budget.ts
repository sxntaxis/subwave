// Listener requests resolve asynchronously behind the existing music queue.
// They do not share the next-song airtime deadline. Give them a bounded,
// queue-aware *total* work budget, never a fresh generic agent deadline for
// each semantic pass. Stay below routes/request.ts's 10-minute ledger TTL.
export const REQUEST_BUDGET_BASE_MS = 300_000;
export const REQUEST_BUDGET_PER_QUEUED_MS = 60_000;
export const REQUEST_BUDGET_MAX_MS = 480_000;
export const REQUEST_AGENT_RUN_MAX_MS = 300_000;
export const REQUEST_FIRST_PASS_RESERVE_MS = 90_000;
export const REQUEST_AUXILIARY_MAX_MS = 90_000;
export const REQUEST_RETRIEVAL_MAX_MS = 30_000;

export function requestBudgetMs(queuedCount: number): number {
  const depth = Number.isFinite(queuedCount) ? Math.max(0, Math.floor(queuedCount)) : 0;
  return Math.min(REQUEST_BUDGET_MAX_MS,
    REQUEST_BUDGET_BASE_MS + Math.min(3, depth) * REQUEST_BUDGET_PER_QUEUED_MS);
}

/** Absolute-deadline allowance: null would silently disable SDK deadlines,
 * so exhausted work MUST throw instead of passing zero to the agent. */
export function requestPhaseMs(
  deadlineAt: number, capMs: number, reserveMs = 0, now = Date.now(),
): number {
  const remaining = Math.floor(deadlineAt - now - reserveMs);
  return Math.max(0, Math.min(capMs, remaining));
}

export function requireRequestPhaseMs(
  deadlineAt: number, capMs: number, reserveMs = 0, now = Date.now(),
): number {
  const ms = requestPhaseMs(deadlineAt, capMs, reserveMs, now);
  if (ms <= 0) {
    const error = new Error('listener request shared work budget exhausted');
    error.name = 'AgentDeadlineError';
    throw error;
  }
  return ms;
}
