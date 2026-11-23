// MI v3: pure editorial cadence and output validation. No LLM, queue, DB, or IO.
// A musical movement is an intention, not an itinerary or an acoustic score.
import { z } from 'zod';
import type { MovementProposal } from './music-direction-core.js';
import type { DirectionDevelopment } from './music-director-v2-core.js';

export type DirectorV3Action = 'seed' | 'review' | null;

// Model wording is bounded at the existing pure validators below. Do not put
// those storage/display limits on the transport schema: a slightly verbose
// response must not invalidate the whole seed before it can be clipped.
export const directorV3SeedSchema = z.object({
  action: z.enum(['seed', 'defer']),
  movement: z.string().min(1).nullable(),
  destination: z.string().min(1).nullable(),
  next: z.string().min(1).nullable(),
  horizonMinutes: z.number().int().min(15).max(40).nullable(),
  energy: z.enum(['build', 'release', 'hold', 'contrast']).nullable(),
  reason: z.string().trim().min(1),
});

export const directorV3ReviewSchema = z.object({
  decision: z.enum(['continue', 'resolve', 'reroute']),
  next: z.string().min(1),
  alternate: z.string().min(1),
  reason: z.string().trim().min(1),
});

/** djObject returns a transport envelope containing `value`; the schema-
 * validated model answer is inside that field, never at the envelope root. */
export function directorV3ModelResult(response: unknown): unknown {
  return response && typeof response === 'object' && 'value' in response
    ? (response as { value: unknown }).value : null;
}
export interface DirectorV3Decision {
  decision: 'seed' | 'continue' | 'resolve' | 'reroute';
  at: string;
  starts: number;
  eventId: string; // persisted privately for idempotency; never returned to the model
  reason: string;
}

/** A new movement requires enough airtime. An existing one may be reviewed close
 * to a show boundary. We never review more than once for a mixer start. */
export function directorV3Due(input: {
  // Only public snapshot fields are needed; the private lastDecision.eventId
  // must never be sent to models or the admin status endpoint.
  movement: { plannedBy?: 'director-v3'; progress?: { starts: number };
    lastDecision?: { at: string; starts: number } | null } | null;
  steering: { source: 'admin' | 'listener' } | null;
  now: number;
  minutesToBoundary: number | null;
  source: 'listener' | 'admin' | 'auto';
  trackId: string | null;
}): DirectorV3Action {
  if (input.steering || input.source !== 'auto' || !input.trackId || !Number.isFinite(input.now)) return null;
  const remaining = input.minutesToBoundary;
  if (!input.movement) return remaining !== null && remaining < 15 ? null : 'seed';
  const m = input.movement;
  if (m.plannedBy !== 'director-v3') return null; // don't rewrite pre-v3 movements
  const last = m.lastDecision;
  if (!last) return 'review';
  const lastMs = Date.parse(last.at);
  const minutes = (input.now - lastMs) / 60_000;
  const starts = (m.progress?.starts ?? 1) - last.starts;
  // No model churn on adjacent songs. One deliberate checkpoint at a time.
  return minutes >= 6 && (starts >= 3 || minutes >= 12 || (remaining !== null && remaining <= 8))
    ? 'review' : null;
}

export function validDirectorSeed(v: unknown, remaining: number | null): MovementProposal | null {
  if (!v || typeof v !== 'object') return null;
  const x = v as Record<string, unknown>;
  if (x.action !== 'seed') return null;
  const clean = (s: unknown, limit: number) => typeof s === 'string'
    ? s.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : '';
  const movement = clean(x.movement, 100);
  const destination = clean(x.destination, 120);
  const next = clean(x.next, 120);
  const horizon = x.horizonMinutes;
  if (!movement || !destination || !next || typeof horizon !== 'number'
      || !Number.isInteger(horizon) || horizon < 15 || horizon > 40) return null;
  if (remaining != null && remaining < 15) return null;
  const max = remaining == null ? 40 : Math.min(40, Math.floor(remaining));
  return { movement, destination, next, horizonMinutes: Math.min(horizon, max),
    energy: x.energy === 'build' || x.energy === 'release' || x.energy === 'hold' || x.energy === 'contrast'
      ? x.energy : null };
}

export function validDirectorReview(v: unknown): DirectionDevelopment | null {
  if (!v || typeof v !== 'object') return null;
  const x = v as Record<string, unknown>;
  if (x.decision !== 'continue' && x.decision !== 'resolve' && x.decision !== 'reroute') return null;
  const clean = (s: unknown) => typeof s === 'string'
    ? s.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120) : '';
  const next = clean(x.next), alternate = clean(x.alternate);
  return next && alternate ? { decision: x.decision, next, alternate } : null;
}

export function boundedDirectorReason(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 180) : '';
}

/** Displayed elapsed time is always measured from real time, never from the
 * track-start counter. It does not assert percentage of musical completion. */
export function movementClock(m: { startedAt: string; expiresAt: string }, now: number) {
  const start = Date.parse(m.startedAt), end = Date.parse(m.expiresAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const total = (end - start) / 60_000;
  const elapsed = Math.max(0, Math.min(total, (now - start) / 60_000));
  return { elapsedMinutes: Math.floor(elapsed), remainingMinutes: Math.ceil(total - elapsed),
    totalMinutes: Math.round(total), percentElapsed: Math.round(elapsed / total * 100) };
}
