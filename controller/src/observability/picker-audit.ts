// Private, opt-in candidate-offer diagnostics. This deliberately bypasses the
// general event log: candidate IDs are local audit data, never a web/API event.
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { currentTrace } from './events.js';

export type PickerAuditPath = 'agent' | 'pool' | 'auto_refresh';
export type PickerAuditOutcome =
  | 'success' | 'empty' | 'rejected' | 'repaired' | 'repicked'
  | 'fallback' | 'collision' | 'error';

export interface PickerAuditResult {
  outcome: PickerAuditOutcome;
  chosenId?: string | null;
  fallbackPath?: 'pool' | 'auto_playlist' | null;
  fallbackReason?: string | null;
  toolCalls?: number | null;
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
  captureCandidates(ids: Iterable<string | null | undefined>): void;
  finish(result: PickerAuditResult): void;
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
  const showAtIso = showAt instanceof Date
    ? (Number.isFinite(showAt.getTime()) ? showAt.toISOString() : null)
    : (typeof showAt === 'string' ? showAt : null);
  let resolvedShowId = showId ?? null;
  const candidates: string[] = [];
  let finished = false;
  return {
    setShowId(id) { resolvedShowId = id ?? null; },
    captureCandidates(ids) {
      if (!options.enabled || finished) return;
      const seen = new Set(candidates);
      for (const id of ids) if (typeof id === 'string' && id && !seen.has(id)) {
        seen.add(id);
        candidates.push(id);
      }
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
