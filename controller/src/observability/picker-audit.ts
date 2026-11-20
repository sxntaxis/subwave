// Private, opt-in candidate-offer diagnostics. This deliberately bypasses the
// general event log: candidate IDs are local audit data, never a web/API event.
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { currentTrace } from './events.js';

export type PickerAuditPath = 'agent' | 'pool' | 'auto_refresh';
export type PickerAuditOutcome =
  | 'success' | 'empty' | 'rejected' | 'repaired' | 'repicked'
  | 'fallback' | 'collision' | 'error';

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
  selection?: PickerSelectionAudit;
  acoustic_search_tool_calls?: number;
  essentia?: PickerEssentiaAudit;
  music_v2?: PickerMusicV2Audit;
}

const ENABLED = process.env.SUBWAVE_PICKER_AUDIT === '1';
const AUDIT_DIR = '/run/subwave-picker-audit';
const MAX_QUEUED = 128;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const RETENTION_DAYS = 7;

export function pickerAuditEnabled(): boolean {
  return ENABLED;
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

export async function appendPickerAuditEvent(event: PickerAuditEvent, directory = AUDIT_DIR): Promise<void> {
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
  captureV2Profiles(ids: Iterable<string | null | undefined>): void;
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
    write: (event: PickerAuditEvent) => void;
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
  let v2ProfileObserved = false;
  const v2ProfileIds = new Set<string>();
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
    captureV2Profiles(ids) {
      if (!options.enabled || finished) return;
      v2Observed = true;
      v2ProfileObserved = true;
      for (const id of ids) if (v2ProfileIds.size < 100_000 && typeof id === 'string' && id) v2ProfileIds.add(id);
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
        ...(hasSelection ? { selection } : selectionExpected ? {
          selection: { status: 'not_invoked', reasons: { collector_not_invoked: 1 } },
        } : {}),
      };
      try { options.write(event); } catch { /* diagnostics never affect a pick */ }
    },
  };
}

// No filesystem access occurs until a complete normal attempt has an outcome.
// Candidate collection is an in-memory ordered set and never consumes RNG.
export function beginPickerAudit(
  path: PickerAuditPath,
  showId: string | null | undefined,
  showAt?: Date | string | null,
): PickerAuditRecorder {
  const trace = currentTrace();
  return createPickerAuditRecorder(path, showId, showAt, {
    enabled: ENABLED,
    attemptId: trace?.traceId ?? null,
    write(event) {
      if (queued >= MAX_QUEUED) { dropped++; return; }
      queued++;
      writeChain = writeChain.then(() => appendPickerAuditEvent(event)).catch(() => { noteError(); }).finally(() => { queued--; });
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
