// Private, opt-in candidate-offer diagnostics. This deliberately bypasses the
// general event log: candidate IDs are local audit data, never a web/API event.
import { constants as fsConstants } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { currentTrace } from './events.js';

export type PickerAuditPath = 'agent' | 'pool' | 'auto_refresh';
export type PickerAuditOutcome =
  | 'success' | 'empty' | 'rejected' | 'repaired' | 'repicked'
  | 'fallback' | 'collision' | 'error';

/**
 * Last observed failed-leg phase: provider_generation requires an SDK model
 * start without a matching end; tool_invocation_or_result requires a started
 * tool without success, or an explicit tool-error end. Recovery/salvage values
 * are set at their actual rejected catch boundaries. Unobserved remains unknown.
 */
export type PickerFailurePhase =
  | 'provider_generation' | 'tool_invocation_or_result' | 'completion_validation'
  | 'done_only_recovery' | 'terminal_collapse' | 'text_salvage'
  | 'caller_boundary' | 'unknown';
export type PickerFailureCategory =
  | 'timeout_deadline' | 'transient_provider_network' | 'provider_http'
  | 'output_schema_validation' | 'tool_execution' | 'aborted_cancelled'
  | 'other' | 'unknown';
/** Retry state of one controller withTransientRetry wrapper, not SDK retries. */
export type PickerFailureRetryStatus =
  | 'attempted' | 'succeeded' | 'exhausted' | 'not_attempted' | 'unknown';
export type PickerFailureFailoverStatus = 'attempted' | 'not_attempted' | 'unknown';
export type PickerComparisonOutcome = 'invoked' | 'success' | 'partial' | 'unavailable' | 'error' | 'unknown';

/** In-memory only; callbacks receive no payload, error, tool name, or identity. */
export interface PickerAgentDiagnosticsObserver {
  failurePhaseObserved(phase: PickerFailurePhase): void;
  providerGenerationStarted(): void;
  providerGenerationCompleted(): void;
  toolStarted(): void;
  toolFinished(success: boolean, comparator?: boolean): void;
  retryNotAttempted(): void;
  retryAttempted(): void;
  retrySucceeded(): void;
  retryExhausted(): void;
  failoverNotAttempted(): void;
  failoverAttempted(): void;
}

// This is the in-process input shape. The event flattens these allowlisted
// values; an Error object is never accepted or serialized by the recorder.
export interface PickerFailureDiagnostics {
  failure_phase: PickerFailurePhase;
  failure_category: PickerFailureCategory;
  failure_retry_status: PickerFailureRetryStatus;
  failure_failover_status?: PickerFailureFailoverStatus;
  failure_http_status?: number;
  failure_elapsed_ms?: number;
  failure_deadline_exhausted?: boolean;
  failure_tool_started_count?: number;
  failure_tool_completed_count?: number;
  failure_tool_failed_count?: number;
}

export interface PickerComparisonObservation {
  outcome: PickerComparisonOutcome;
  inputCount: number;
  /** Count of input candidates with evidence returned, not output array length. */
  outputCount: number;
}

export type PickerSelectionReason =
  | 'no_eligible_context' | 'index_unavailable' | 'deadline_or_budget'
  | 'missing_predecessor_evidence' | 'missing_flow' | 'candidate_ceiling'
  | 'scorer_exception' | 'scored_no_membership_change' | 'scored_membership_change'
  | 'collector_not_invoked';

export interface PickerSelectionObservation {
  reason: PickerSelectionReason;
  eligibleCandidates: number;
  offeredCandidates: number;
  lookupMs?: number | null;
  orderedShortlistChanged?: boolean;
}

export type PickerSelectionAudit =
  | {
    status: 'observed';
    scored: number;
    baseline: number;
    reasons: Partial<Record<PickerSelectionReason, number>>;
    eligible_candidates: number;
    offered_candidates: number;
    lookup_ms: number;
    ordered_shortlists_changed: number;
  }
  | {
    status: 'not_invoked';
    reasons: Partial<Record<PickerSelectionReason, number>>;
  };

export interface PickerAuditResult {
  outcome: PickerAuditOutcome;
  chosenId?: string | null;
  fallbackPath?: 'pool' | 'auto_playlist' | null;
  fallbackReason?: string | null;
  toolCalls?: number | null;
  acousticSearchToolCalls?: number | null;
  failure?: PickerFailureDiagnostics;
}

export interface PickerEssentiaAudit {
  availability: 'available' | 'unavailable' | 'not_checked';
  profiled_candidates_exposed: number | 'not_invoked';
  trait_tool_invocations: number;
  trait_candidates_exposed: number;
  trait_result: 'returned' | 'empty' | 'unavailable' | 'error_or_timeout' | 'not_invoked';
  chosen_had_exposed_profile: boolean | null;
  chosen_from_trait_result: boolean | null;
}

export interface PickerMusicV2Audit {
  joint_calls: number;
  joint_unavailable: number;
  compare_calls: number;
  profile_candidates_exposed: number;
  chosen_had_exposed_profile: boolean | null;
}

export interface PickerAuditEvent {
  schema_version: 1;
  timestamp: string;
  attempt_id: string | null;
  path: PickerAuditPath;
  show_id: string | null;
  show_at: string | null;
  candidate_ids: string[];
  chosen_id: string | null;
  outcome: PickerAuditOutcome;
  fallback_path?: 'pool' | 'auto_playlist';
  fallback_reason?: string;
  tool_calls?: number;
  seen_candidate_count?: number;
  failure_phase?: PickerFailurePhase;
  failure_category?: PickerFailureCategory;
  failure_retry_status?: PickerFailureRetryStatus;
  /** Observations from controller withTransientRetry only; SDK-internal retries remain unknown. */
  failure_transient_retry_status?: PickerFailureRetryStatus;
  failure_failover_status?: PickerFailureFailoverStatus;
  failure_http_status?: number;
  failure_elapsed_ms?: number;
  failure_deadline_exhausted?: boolean;
  failure_tool_started_count?: number;
  failure_tool_completed_count?: number;
  failure_tool_failed_count?: number;
  selection?: PickerSelectionAudit;
  acoustic_search_tool_calls?: number;
  essentia?: PickerEssentiaAudit;
  music_v2?: PickerMusicV2Audit;
  comparison?: {
    invocations: number;
    /** Outcome and aggregates below describe the most recently completed comparison call. */
    outcome: PickerComparisonOutcome;
    input_count: number;
    output_count: number;
    /** Per-call returned-evidence coverage; says nothing about final pick influence. */
    coverage: number | null;
  };
}

export interface PickerAuditLifecycleEvent {
  event_type: 'v2_lifecycle';
  lifecycle_version: 1;
  timestamp: string;
  attempt_id: string;
  stage: 'selected' | 'enqueue_rejected' | 'enqueued' | 'controller_observed_track_start';
  v2_joint_offered?: boolean;
  outcome?: string;
}

const ENABLED = process.env.SUBWAVE_PICKER_AUDIT === '1';
const AUDIT_DIR = '/run/subwave-picker-audit';
const MAX_QUEUED = 128;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const RETENTION_DAYS = 7;
const MAX_FAILURE_ELAPSED_MS = 10 * 60_000;
const MAX_FAILURE_CHAIN = 6;

interface PickerAuditTestContext {
  enabled: boolean;
  write: (event: PickerAuditEvent | PickerAuditLifecycleEvent) => void;
}
const pickerAuditTestContext = new AsyncLocalStorage<PickerAuditTestContext>();

// Scoped in-memory test hook for exercising caller wiring without touching the
// station's private audit directory. Production never enters this context.
export function withPickerAuditForTest<T>(
  context: PickerAuditTestContext,
  fn: () => T,
): T {
  return pickerAuditTestContext.run(context, fn);
}

const FAILURE_PHASES = new Set<PickerFailurePhase>([
  'provider_generation', 'tool_invocation_or_result', 'completion_validation',
  'done_only_recovery', 'terminal_collapse', 'text_salvage',
  'caller_boundary', 'unknown',
]);
const FAILURE_CATEGORIES = new Set<PickerFailureCategory>([
  'timeout_deadline', 'transient_provider_network', 'provider_http',
  'output_schema_validation', 'tool_execution', 'aborted_cancelled', 'other', 'unknown',
]);
const FAILURE_RETRY_STATUSES = new Set<PickerFailureRetryStatus>([
  'attempted', 'succeeded', 'exhausted', 'not_attempted', 'unknown',
]);
const FAILURE_FAILOVER_STATUSES = new Set<PickerFailureFailoverStatus>([
  'attempted', 'not_attempted', 'unknown',
]);
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND',
]);

function safeProperty(value: unknown, key: string): unknown {
  try {
    return value && (typeof value === 'object' || typeof value === 'function')
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

function failureErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const visited = new Set<unknown>();
  let current = error;
  for (let i = 0; i < MAX_FAILURE_CHAIN && current != null && !visited.has(current); i++) {
    chain.push(current);
    if ((typeof current !== 'object' && typeof current !== 'function')) break;
    visited.add(current);
    const cause = safeProperty(current, 'cause');
    const lastError = safeProperty(current, 'lastError');
    const errors = safeProperty(current, 'errors');
    const lastNestedError = Array.isArray(errors) ? errors.at(-1) : undefined;
    current = cause ?? lastError ?? lastNestedError;
  }
  return chain;
}

function failureStatus(chain: readonly unknown[]): number | undefined {
  for (const error of chain) {
    for (const key of ['statusCode', 'status']) {
      const status = safeProperty(error, key);
      if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
        return status;
      }
    }
  }
  return undefined;
}

function failureCategory(chain: readonly unknown[], status: number | undefined): PickerFailureCategory {
  const names = chain.map(error => safeProperty(error, 'name')).filter((name): name is string => typeof name === 'string');
  const codes = chain.map(error => safeProperty(error, 'code'))
    .filter((code): code is string => typeof code === 'string' && code.length <= 64)
    .map(code => code.toUpperCase());
  if (names.includes('AgentDeadlineError') || names.includes('TimeoutError')) return 'timeout_deadline';
  if (names.includes('AbortError') || codes.includes('ABORT_ERR')) return 'aborted_cancelled';
  if (names.some(name => [
    'ZodError', 'AI_NoObjectGeneratedError', 'AI_NoOutputGeneratedError',
  ].includes(name))) return 'output_schema_validation';
  if (names.some(name => [
    'AI_InvalidToolInputError', 'ToolExecutionError',
  ].includes(name))) return 'tool_execution';
  if (status !== undefined) return 'provider_http';
  if (codes.some(code => TRANSIENT_NETWORK_CODES.has(code))) return 'transient_provider_network';
  if (names.length) return 'other';
  return 'unknown';
}

/**
 * Build sanitized error facts only. Lifecycle fields are supplied separately
 * by the in-process observer; none are inferred from the thrown object.
 */
export function classifyPickerFailure(error: unknown, elapsedMs?: number): PickerFailureDiagnostics {
  try {
    const chain = failureErrorChain(error);
    const status = failureStatus(chain);
    const deadlineExhausted = chain.some(item => safeProperty(item, 'name') === 'AgentDeadlineError');
    const elapsed = typeof elapsedMs === 'number' && Number.isFinite(elapsedMs)
      ? Math.min(MAX_FAILURE_ELAPSED_MS, Math.max(0, Math.round(elapsedMs)))
      : undefined;
    return {
      failure_phase: 'unknown',
      failure_category: failureCategory(chain, status),
      failure_retry_status: 'unknown',
      ...(status === undefined ? {} : { failure_http_status: status }),
      ...(elapsed === undefined ? {} : { failure_elapsed_ms: elapsed }),
      ...(deadlineExhausted ? { failure_deadline_exhausted: true } : {}),
    };
  } catch {
    // Diagnostics are strictly best-effort, including hostile getters on an
    // unexpected thrown value. Never let classification replace the failure.
    return {
      failure_phase: 'unknown',
      failure_category: 'unknown',
      failure_retry_status: 'unknown',
    };
  }
}

function safeFailureFields(failure: PickerFailureDiagnostics | undefined): Partial<PickerFailureDiagnostics> {
  if (!failure) return {};
  const phase = FAILURE_PHASES.has(failure.failure_phase) ? failure.failure_phase : 'unknown';
  const category = FAILURE_CATEGORIES.has(failure.failure_category) ? failure.failure_category : 'unknown';
  const retryStatus = FAILURE_RETRY_STATUSES.has(failure.failure_retry_status)
    ? failure.failure_retry_status : 'unknown';
  const status = failure.failure_http_status;
  const elapsed = failure.failure_elapsed_ms;
  return {
    failure_phase: phase,
    failure_category: category,
    failure_retry_status: retryStatus,
    ...(failure.failure_failover_status && FAILURE_FAILOVER_STATUSES.has(failure.failure_failover_status)
      ? { failure_failover_status: failure.failure_failover_status } : {}),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? { failure_http_status: status } : {}),
    ...(typeof elapsed === 'number' && Number.isFinite(elapsed)
      ? { failure_elapsed_ms: Math.min(MAX_FAILURE_ELAPSED_MS, Math.max(0, Math.floor(elapsed))) } : {}),
    ...(typeof failure.failure_deadline_exhausted === 'boolean'
      ? { failure_deadline_exhausted: failure.failure_deadline_exhausted } : {}),
    ...(typeof failure.failure_tool_started_count === 'number' && Number.isFinite(failure.failure_tool_started_count)
      ? { failure_tool_started_count: Math.min(1000, Math.max(0, Math.floor(failure.failure_tool_started_count))) } : {}),
    ...(typeof failure.failure_tool_completed_count === 'number' && Number.isFinite(failure.failure_tool_completed_count)
      ? { failure_tool_completed_count: Math.min(1000, Math.max(0, Math.floor(failure.failure_tool_completed_count))) } : {}),
    ...(typeof failure.failure_tool_failed_count === 'number' && Number.isFinite(failure.failure_tool_failed_count)
      ? { failure_tool_failed_count: Math.min(1000, Math.max(0, Math.floor(failure.failure_tool_failed_count))) } : {}),
  };
}

export function pickerAuditEnabled(): boolean {
  return pickerAuditTestContext.getStore()?.enabled ?? ENABLED;
}

let writeChain: Promise<void> = Promise.resolve();
let queued = 0;
let writes = 0;
let errors = 0;
let dropped = 0;
let lastPrunedDay = '';

function noteError(): void {
  errors++;
  if (errors === 1) console.warn('[picker-audit] private telemetry write failed; selection continues without audit data');
}

function auditPath(at: string, directory: string): string {
  return `${directory}/offers-${at.slice(0, 10)}.jsonl`;
}

async function pruneOldFiles(today: string, directory: string): Promise<void> {
  if (lastPrunedDay === today) return;
  lastPrunedDay = today;
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - (RETENTION_DAYS - 1) * 86_400_000)
    .toISOString().slice(0, 10);
  let names: string[];
  try { names = await readdir(directory); } catch { noteError(); return; }
  for (const name of names) {
    const match = name.match(/^offers-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!match || match[1] >= cutoff) continue;
    try { await unlink(`${directory}/${name}`); } catch { noteError(); }
  }
}

export async function appendPickerAuditEvent(event: PickerAuditEvent | PickerAuditLifecycleEvent, directory = AUDIT_DIR): Promise<void> {
  try {
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && dir.uid !== process.getuid())
      || (typeof process.getgid === 'function' && dir.gid !== process.getgid())) {
      noteError();
      return;
    }
    await pruneOldFiles(event.timestamp.slice(0, 10), directory);
    const path = auditPath(event.timestamp, directory);
    const line = `${JSON.stringify(event)}\n`;
    const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT
      | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(path, flags, 0o600);
    try {
      const file = await handle.stat();
      if (!file.isFile() || (file.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && file.uid !== process.getuid())
        || (typeof process.getgid === 'function' && file.gid !== process.getgid())) {
        noteError();
        return;
      }
      if (file.size + Buffer.byteLength(line) > MAX_FILE_BYTES) { dropped++; return; }
      await handle.writeFile(line, { encoding: 'utf8' });
      writes++;
    } finally {
      await handle.close();
    }
  } catch {
    noteError();
  }
}

export interface PickerAuditRecorder {
  setShowId(id: string | null | undefined): void;
  setShowAt(at: Date | string | null | undefined): void;
  captureCandidates(ids: Iterable<string | null | undefined>): void;
  captureSelection(observation: PickerSelectionObservation): void;
  expectSelectionObservation(): void;
  setEssentiaAvailability(available: boolean): void;
  captureProfileExposure(ids: Iterable<string | null | undefined>): void;
  noteTraitInvocation(): void;
  captureTraitResult(ids: Iterable<string | null | undefined>, status: PickerEssentiaAudit['trait_result']): void;
  noteV2Joint(unavailable: boolean): void;
  noteV2Compare(): void;
  captureV2Comparison(observation: PickerComparisonObservation): void;
  agentDiagnosticsObserver(): PickerAgentDiagnosticsObserver | undefined;
  captureV2Profiles(ids: Iterable<string | null | undefined>): void;
  captureV2JointCandidates(ids: Iterable<string | null | undefined>): void;
  captureV2Selection(id: string): boolean;
  recordV2EnqueueRejected(outcome: string): void;
  recordV2Enqueued(token: string): void;
  finish(result: PickerAuditResult): void;
}

export function bindPickerSelectionAudit(
  audit: PickerAuditRecorder,
  enabled: boolean,
): ((observation: PickerSelectionObservation) => void) | undefined {
  if (!enabled) return undefined;
  audit.expectSelectionObservation();
  return observation => audit.captureSelection(observation);
}

export function finishAgentPickerAudit(
  audit: PickerAuditRecorder,
  input: {
    candidateIds: Iterable<string | null | undefined>;
    chosenId?: string | null;
    outcome: PickerAuditOutcome;
    toolCalls: readonly { name?: string }[];
    fallbackPath?: 'pool' | 'auto_playlist' | null;
    fallbackReason?: string | null;
  },
): void {
  audit.captureCandidates(input.candidateIds);
  audit.finish({
    outcome: input.outcome,
    chosenId: input.chosenId,
    fallbackPath: input.fallbackPath,
    fallbackReason: input.fallbackReason,
    toolCalls: input.toolCalls.length,
    acousticSearchToolCalls: input.toolCalls.filter(call =>
      call.name === 'tracksThatSoundLikeThis' || call.name === 'searchBySound'
        || call.name === 'tracksTowardJourney').length,
  });
}

export function createPickerAuditRecorder(
  path: PickerAuditPath,
  showId: string | null | undefined,
  showAt: Date | string | null | undefined,
  options: {
    enabled: boolean;
    attemptId: string | null;
    now?: () => Date;
    write: (event: PickerAuditEvent | PickerAuditLifecycleEvent) => void;
  },
): PickerAuditRecorder {
  let showAtIso = showAt instanceof Date
    ? (Number.isFinite(showAt.getTime()) ? showAt.toISOString() : null)
    : (typeof showAt === 'string' ? showAt : null);
  let resolvedShowId = showId ?? null;
  const candidates: string[] = [];
  const selection: Extract<PickerSelectionAudit, { status: 'observed' }> = {
    status: 'observed', scored: 0, baseline: 0, reasons: {}, eligible_candidates: 0,
    offered_candidates: 0, lookup_ms: 0, ordered_shortlists_changed: 0,
  };
  let hasSelection = false;
  let selectionExpected = false;
  let essentiaAvailability: PickerEssentiaAudit['availability'] = 'not_checked';
  let profileObserved = false;
  const profileIds = new Set<string>();
  const traitIds = new Set<string>();
  let traitInvocations = 0;
  let traitResult: PickerEssentiaAudit['trait_result'] = 'not_invoked';
  let v2Observed = false;
  let v2JointCalls = 0;
  let v2JointUnavailable = 0;
  let v2CompareCalls = 0;
  let comparisonInvocations = 0;
  let comparisonOutcome: PickerComparisonOutcome = 'unknown';
  let comparisonInputCount = 0;
  let comparisonOutputCount = 0;
  let toolStartedCount = 0;
  let toolCompletedCount = 0;
  let toolFailedCount = 0;
  let retryStatus: PickerFailureRetryStatus = 'unknown';
  let failoverStatus: PickerFailureFailoverStatus = 'unknown';
  let failurePhase: PickerFailurePhase = 'unknown';
  let agentDiagnosticsObserved = false;
  let v2ProfileObserved = false;
  const v2ProfileIds = new Set<string>();
  const v2JointIds = new Set<string>();
  let selectedJoint = false;
  let finished = false;
  return {
    setShowId(id) { resolvedShowId = id ?? null; },
    setShowAt(at) {
      showAtIso = at instanceof Date
        ? (Number.isFinite(at.getTime()) ? at.toISOString() : null)
        : (typeof at === 'string' ? at : null);
    },
    captureCandidates(ids) {
      if (!options.enabled || finished) return;
      const seen = new Set(candidates);
      for (const id of ids) if (typeof id === 'string' && id && !seen.has(id)) {
        seen.add(id);
        candidates.push(id);
      }
    },
    captureSelection(observation) {
      if (!options.enabled || finished) return;
      hasSelection = true;
      const reason = observation.reason;
      selection.reasons[reason] = Math.min(1000, (selection.reasons[reason] ?? 0) + 1);
      if (reason === 'scored_membership_change' || reason === 'scored_no_membership_change') selection.scored++;
      else selection.baseline++;
      selection.eligible_candidates = Math.min(100_000, selection.eligible_candidates + Math.max(0, Math.floor(observation.eligibleCandidates)));
      selection.offered_candidates = Math.min(100_000, selection.offered_candidates + Math.max(0, Math.floor(observation.offeredCandidates)));
      if (typeof observation.lookupMs === 'number' && Number.isFinite(observation.lookupMs)) {
        selection.lookup_ms = Math.min(600_000, selection.lookup_ms + Math.max(0, observation.lookupMs));
      }
      if (observation.orderedShortlistChanged) selection.ordered_shortlists_changed++;
    },
    expectSelectionObservation() {
      if (options.enabled && !finished) selectionExpected = true;
    },
    setEssentiaAvailability(available) {
      if (options.enabled && !finished) essentiaAvailability = available ? 'available' : 'unavailable';
    },
    captureProfileExposure(ids) {
      if (!options.enabled || finished) return;
      profileObserved = true;
      for (const id of ids) if (profileIds.size < 100_000 && typeof id === 'string' && id) profileIds.add(id);
    },
    noteTraitInvocation() {
      if (!options.enabled || finished) return;
      traitInvocations = Math.min(1000, traitInvocations + 1);
      if (traitResult === 'not_invoked') traitResult = 'empty';
    },
    captureTraitResult(ids, status) {
      if (!options.enabled || finished) return;
      traitResult = status;
      for (const id of ids) if (traitIds.size < 100_000 && typeof id === 'string' && id) traitIds.add(id);
    },
    noteV2Joint(unavailable) {
      if (!options.enabled || finished) return;
      v2Observed = true;
      v2JointCalls = Math.min(1000, v2JointCalls + 1);
      if (unavailable) v2JointUnavailable = Math.min(1000, v2JointUnavailable + 1);
    },
    noteV2Compare() {
      if (!options.enabled || finished) return;
      v2Observed = true;
      v2CompareCalls = Math.min(1000, v2CompareCalls + 1);
    },
    captureV2Comparison(observation) {
      if (!options.enabled || finished) return;
      if (observation.outcome === 'invoked' || comparisonInvocations === 0) {
        comparisonInvocations = Math.min(1000, comparisonInvocations + 1);
      }
      comparisonOutcome = observation.outcome;
      comparisonInputCount = Math.min(4, Math.max(0, Math.floor(observation.inputCount)));
      comparisonOutputCount = Math.min(4, Math.max(0, Math.floor(observation.outputCount)));
    },
    agentDiagnosticsObserver() {
      if (!options.enabled || finished) return undefined;
      agentDiagnosticsObserved = true;
      return {
        failurePhaseObserved(phase) {
          if (FAILURE_PHASES.has(phase)) failurePhase = phase;
        },
        providerGenerationStarted() { failurePhase = 'provider_generation'; },
        providerGenerationCompleted() { failurePhase = 'unknown'; },
        toolStarted() {
          failurePhase = 'tool_invocation_or_result';
          toolStartedCount = Math.min(1000, toolStartedCount + 1);
        },
        toolFinished(success, comparator = false) {
          failurePhase = success ? 'unknown' : 'tool_invocation_or_result';
          if (success) toolCompletedCount = Math.min(1000, toolCompletedCount + 1);
          else toolFailedCount = Math.min(1000, toolFailedCount + 1);
          if (comparator && !success && comparisonInvocations > 0) comparisonOutcome = 'error';
        },
        retryNotAttempted() { if (retryStatus === 'unknown') retryStatus = 'not_attempted'; },
        retryAttempted() { retryStatus = 'attempted'; },
        retrySucceeded() { retryStatus = 'succeeded'; },
        retryExhausted() { retryStatus = 'exhausted'; },
        failoverNotAttempted() { if (failoverStatus === 'unknown') failoverStatus = 'not_attempted'; },
        failoverAttempted() {
          failoverStatus = 'attempted';
          retryStatus = 'unknown';
          failurePhase = 'unknown';
        },
      };
    },
    captureV2Profiles(ids) {
      if (!options.enabled || finished) return;
      v2Observed = true;
      v2ProfileObserved = true;
      for (const id of ids) if (v2ProfileIds.size < 100_000 && typeof id === 'string' && id) v2ProfileIds.add(id);
    },
    captureV2JointCandidates(ids) {
      if (!options.enabled || finished) return;
      v2Observed = true;
      for (const id of ids) if (v2JointIds.size < 100_000 && typeof id === 'string' && id) v2JointIds.add(id);
    },
    captureV2Selection(id) {
      if (!options.enabled || finished) return false;
      selectedJoint = v2JointIds.has(id);
      if (v2Observed) writeLifecycle(options, {
        stage: 'selected',
        v2_joint_offered: selectedJoint,
      });
      return selectedJoint;
    },
    recordV2EnqueueRejected(outcome) {
      if (!options.enabled || finished || !selectedJoint) return;
      writeLifecycle(options, { stage: 'enqueue_rejected', outcome: outcome.slice(0, 32) });
    },
    recordV2Enqueued(token) {
      if (!options.enabled || finished || !selectedJoint || !/^[0-9a-f]{32}$/.test(token)) return;
      const attemptId = options.attemptId;
      if (!attemptId) return;
      writeLifecycle(options, { stage: 'enqueued' });
      rememberV2Acceptance(token, attemptId);
    },
    finish(result) {
      if (!options.enabled || finished) return;
      finished = true;
      const timestamp = (options.now ?? (() => new Date()))().toISOString();
      const event: PickerAuditEvent = {
        schema_version: 1,
        timestamp,
        attempt_id: options.attemptId,
        path,
        show_id: resolvedShowId,
        show_at: showAtIso,
        candidate_ids: candidates,
        chosen_id: result.chosenId ?? null,
        outcome: result.outcome,
        ...(result.fallbackPath ? { fallback_path: result.fallbackPath } : {}),
        ...(result.fallbackReason ? { fallback_reason: result.fallbackReason.slice(0, 80) } : {}),
        ...(path === 'agent' && result.outcome === 'error' && result.failure
          ? {
            ...safeFailureFields(result.failure),
            failure_phase: failurePhase === 'unknown' ? result.failure.failure_phase : failurePhase,
            ...(retryStatus !== 'unknown' ? { failure_transient_retry_status: retryStatus } : {}),
            ...(failoverStatus !== 'unknown' ? { failure_failover_status: failoverStatus } : {}),
            ...(agentDiagnosticsObserved ? {
              failure_tool_started_count: toolStartedCount,
              failure_tool_completed_count: toolCompletedCount,
              failure_tool_failed_count: toolFailedCount,
            } : {}),
            seen_candidate_count: Math.min(100_000, candidates.length),
          }
          : {}),
        ...(typeof result.toolCalls === 'number' && Number.isInteger(result.toolCalls) && result.toolCalls >= 0 ? { tool_calls: result.toolCalls } : {}),
        ...(typeof result.acousticSearchToolCalls === 'number' && Number.isInteger(result.acousticSearchToolCalls)
          && result.acousticSearchToolCalls >= 0 ? { acoustic_search_tool_calls: Math.min(1000, result.acousticSearchToolCalls) } : {}),
        ...(path === 'agent' ? { essentia: {
          availability: essentiaAvailability,
          profiled_candidates_exposed: profileObserved ? profileIds.size : 'not_invoked',
          trait_tool_invocations: traitInvocations,
          trait_candidates_exposed: traitIds.size,
          trait_result: traitResult,
          chosen_had_exposed_profile: ['success', 'repaired', 'repicked'].includes(result.outcome)
            && typeof result.chosenId === 'string' && profileObserved
            ? profileIds.has(result.chosenId) : null,
          chosen_from_trait_result: ['success', 'repaired', 'repicked'].includes(result.outcome)
            && typeof result.chosenId === 'string'
            ? traitInvocations > 0 ? traitIds.has(result.chosenId) : false : null,
        } } : {}),
        ...(path === 'agent' && v2Observed ? { music_v2: {
          joint_calls: v2JointCalls,
          joint_unavailable: v2JointUnavailable,
          compare_calls: v2CompareCalls,
          profile_candidates_exposed: v2ProfileIds.size,
          chosen_had_exposed_profile: ['success', 'repaired', 'repicked'].includes(result.outcome)
            && typeof result.chosenId === 'string' && v2ProfileObserved ? v2ProfileIds.has(result.chosenId) : null,
        } } : {}),
        ...(path === 'agent' && comparisonInvocations ? { comparison: {
          invocations: comparisonInvocations,
          outcome: comparisonOutcome,
          input_count: comparisonInputCount,
          output_count: comparisonOutputCount,
          coverage: comparisonInputCount > 0 ? comparisonOutputCount / comparisonInputCount : null,
        } } : {}),
        ...(hasSelection ? { selection } : selectionExpected ? {
          selection: { status: 'not_invoked', reasons: { collector_not_invoked: 1 } },
        } : {}),
      };
      try { options.write(event); } catch { /* diagnostics never affect a pick */ }
    },
  };
}

type AuditOptions = { enabled: boolean; attemptId: string | null; now?: () => Date; write: (event: PickerAuditEvent | PickerAuditLifecycleEvent) => void };
function writeLifecycle(options: AuditOptions, fields: Omit<PickerAuditLifecycleEvent, 'event_type' | 'lifecycle_version' | 'timestamp' | 'attempt_id'>) {
  if (!options.enabled || !options.attemptId) return;
  options.write({
    event_type: 'v2_lifecycle', lifecycle_version: 1,
    timestamp: (options.now ?? (() => new Date()))().toISOString(),
    attempt_id: options.attemptId, ...fields,
  });
}

const v2Accepted = new Map<string, { attemptId: string; at: number }>();
function rememberV2Acceptance(token: string, attemptId: string): void {
  const now = Date.now();
  for (const [key, item] of v2Accepted) if (now - item.at > 24 * 60 * 60 * 1000) v2Accepted.delete(key);
  if (v2Accepted.size >= 2048) v2Accepted.delete(v2Accepted.keys().next().value!);
  v2Accepted.set(token, { attemptId, at: now });
}

export function observeV2QueueStart(
  token: unknown,
  emit: (attemptId: string) => void = attemptId => {
    writeLifecycle({
      enabled: true, attemptId,
      write(event) { queueAuditEvent(event); },
    }, { stage: 'controller_observed_track_start' });
  },
  enabled = ENABLED,
): boolean {
  if (!enabled || typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return false;
  const accepted = v2Accepted.get(token);
  if (!accepted) return false;
  v2Accepted.delete(token);
  try { emit(accepted.attemptId); } catch { /* attribution is best effort */ }
  return true;
}

function queueAuditEvent(event: PickerAuditEvent | PickerAuditLifecycleEvent): void {
  if (queued >= MAX_QUEUED) { dropped++; return; }
  queued++;
  writeChain = writeChain.then(() => appendPickerAuditEvent(event)).catch(() => { noteError(); }).finally(() => { queued--; });
}

// No filesystem access occurs until a complete normal attempt has an outcome.
// Candidate collection is an in-memory ordered set and never consumes RNG.
export function beginPickerAudit(
  path: PickerAuditPath,
  showId: string | null | undefined,
  showAt?: Date | string | null,
): PickerAuditRecorder {
  const trace = currentTrace();
  const testContext = pickerAuditTestContext.getStore();
  return createPickerAuditRecorder(path, showId, showAt, {
    enabled: testContext?.enabled ?? ENABLED,
    attemptId: trace?.traceId ?? null,
    write(event) {
      if (testContext) testContext.write(event);
      else queueAuditEvent(event);
    },
  });
}

// Read by local tests/verification only. Not wired to a route or general log.
export function pickerAuditDiagnostics() {
  return { enabled: ENABLED, writes, errors, dropped, queued };
}

export async function flushPickerAuditForTests(): Promise<void> {
  await writeChain;
}
