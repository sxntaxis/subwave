// MI v2.5 runtime adapter. One bounded verified lookup and a tiny recent cache,
// never an LLM call or a second scheduler. Only actual starts form the history.
import { getEssentiaReader, lookupV2WithStatus } from './essentia-evidence.js';
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { STATE_DIR } from '../config.js';
import { measureTrajectory, sonicPoint, type AiredSonicPoint, type SonicPoint, type TrajectoryEnergy, type MeasuredTrajectory } from './trajectory-engine.js';

export const trajectoryEnabled = () => process.env.SUBWAVE_MUSIC_DIRECTION_V1 === '1'
  && process.env.SUBWAVE_MUSIC_DIRECTOR_V2 === '1'
  && process.env.SUBWAVE_MUSIC_TRAJECTORY_V1 === '1';
export interface VerifiedStart { eventId: string; showId: string | null; trackId: string | null }
type Cache = { key: string; expires: number; showId: string | null; movementStartedAt: string;
  predecessorId: string | null; predecessor: SonicPoint | null; measured: MeasuredTrajectory };
let cache: Cache | null = null;
/** Separate from the 45-second *picker* cache: the dashboard should not lose
 * its last factual observation just because no new song was selected. */
export interface TrajectoryObservationV3 {
  status: 'not_measured' | 'unavailable' | 'insufficient' | 'measured' | 'stale';
  verifiedStarts: number;
  observedAt: string | null;
  measured: MeasuredTrajectory | null;
  note: string;
}
type DurableObservation = { showId: string | null; startedAt: string; eventIds: string[];
  snapshot: TrajectoryObservationV3 };
const V3_TRAJECTORY_FILE = join(STATE_DIR, 'mi-v3-trajectory.json');
function loadV3(): DurableObservation | null {
  if (!v3Active() || !existsSync(V3_TRAJECTORY_FILE)) return null;
  try {
    const raw = readFileSync(V3_TRAJECTORY_FILE, 'utf8');
    if (raw.length > 8192) return null;
    const v = JSON.parse(raw) as DurableObservation;
    return v && (v.showId === null || typeof v.showId === 'string')
      && Number.isFinite(Date.parse(v.startedAt))
      && Array.isArray(v.eventIds) && v.eventIds.length <= 8
      && v.eventIds.every((e: unknown) => typeof e === 'string' && e.length <= 300)
      && v.snapshot && ['measured','insufficient','unavailable'].includes(v.snapshot.status)
      && v.snapshot.observedAt && Number.isFinite(Date.parse(v.snapshot.observedAt))
      ? v : null;
  } catch { return null; }
}
let latest: DurableObservation | null = loadV3();
function saveV3(value: DurableObservation) {
  if (!v3Active()) return;
  const temp = join(dirname(V3_TRAJECTORY_FILE), `.mi-v3-${process.pid}-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, V3_TRAJECTORY_FILE);
  } catch { try { unlinkSync(temp); } catch {} /* best-effort diagnostics only */ }
}
function v3Active() { return trajectoryEnabled() && process.env.SUBWAVE_MI_DIRECTOR_V3 === '1'; }
function rememberV3(showId: string | null, startedAt: string, events: string[],
  status: TrajectoryObservationV3['status'], measured: MeasuredTrajectory | null, note: string) {
  if (!v3Active()) return;
  // A slow earlier lookup must not replace newer verified history.
  if (latest?.showId === showId && latest.startedAt === startedAt && latest.eventIds[0]
      && latest.eventIds[0] !== events[0] && events.includes(latest.eventIds[0]) === false
      && latest.eventIds.includes(events[0])) return;
  latest = { showId, startedAt, eventIds: events.slice(), snapshot: {
    status, verifiedStarts: events.length, observedAt: new Date().toISOString(), measured, note,
  } };
  saveV3(latest);
}
/** Read-only dashboard projection: no Essentia access, AI call, or HTTP request. */
export function trajectoryObservationV3(showId: string | null, startedAt: string,
  currentEvents: readonly string[]): TrajectoryObservationV3 | null {
  if (!v3Active()) return null;
  if (!latest || latest.showId !== showId || latest.startedAt !== startedAt) return {
    status: 'not_measured', verifiedStarts: currentEvents.length, observedAt: null,
    measured: null, note: 'No acoustic measurement has been attempted for this movement.',
  };
  const changed = currentEvents.length !== latest.eventIds.length
    || currentEvents.some((event, i) => event !== latest!.eventIds[i]);
  return changed ? { ...latest.snapshot, status: 'stale', verifiedStarts: currentEvents.length,
    note: 'New verified airplay since this measurement; the previous result is historical only.' }
    : latest.snapshot;
}
export function cachedTrajectory(showId: string | null, movementStartedAt: string) {
  const active = cache;
  if (!trajectoryEnabled() || !active || active.showId !== showId || active.movementStartedAt !== movementStartedAt || active.expires <= Date.now()) return null;
  return { ...active.measured, observedAt: new Date(active.expires - 45_000).toISOString() };
}
export function cachedPredecessor(id: string | null | undefined, showId: string | null,
  movementStartedAt: string | null | undefined): SonicPoint | null {
  const active = cache;
  return trajectoryEnabled() && !!active && active.predecessorId === id && active.showId === showId
    && !!movementStartedAt && active.movementStartedAt === movementStartedAt && active.expires > Date.now()
    ? active.predecessor : null;
}
export async function inspectVerifiedTrajectory(
  showId: string | null, recent: readonly VerifiedStart[], direction: TrajectoryEnergy,
  movementStartedAt: string,
): Promise<MeasuredTrajectory | null> {
  if (!trajectoryEnabled()) return null;
  const actual = recent.filter(s => s.showId === showId && s.trackId && s.eventId).slice(0, 8);
  if (actual.length < 3) {
    rememberV3(showId, movementStartedAt, actual.map(s => s.eventId), 'insufficient', null,
      'Fewer than three identity-verified starts in this movement.');
    return null;
  }
  const events = actual.map(s => s.eventId);
  const key = JSON.stringify([showId, movementStartedAt, direction, events]);
  if (cache?.key === key && cache.expires > Date.now()) {
    if (v3Active() && (!latest || latest.showId !== showId || latest.startedAt !== movementStartedAt))
      rememberV3(showId, movementStartedAt, events, cache.measured.status, cache.measured, cache.measured.note);
    return cache.measured;
  }
  const reader = getEssentiaReader();
  if (!reader?.lookupV2) {
    rememberV3(showId, movementStartedAt, events, 'unavailable', null,
      'Acoustic reader is unavailable; this is not evidence of an incomplete movement.');
    return null;
  }
  const ids = [...new Set(actual.map(s => s.trackId!))].slice(0, 8);
  try {
    const result = await lookupV2WithStatus(reader, ids);
    if (result.status !== 'ok') {
      rememberV3(showId, movementStartedAt, events, 'unavailable', null,
        'Acoustic lookup was incomplete or unavailable; previous estimates are not current.');
      return null;
    }
    const points: AiredSonicPoint[] = actual.map(s => ({ id: s.trackId!, eventId: s.eventId,
      ...(sonicPoint(result.rows.get(s.trackId!)) ?? { arousal: null, valence: null, danceability: null }) }));
    const measured = measureTrajectory(points, direction);
    cache = { key, expires: Date.now() + 45_000, showId, movementStartedAt,
      predecessorId: actual[0].trackId, predecessor: sonicPoint(result.rows.get(actual[0].trackId!)), measured };
    rememberV3(showId, movementStartedAt, events, measured.status, measured, measured.note);
    return measured;
  } catch {
    rememberV3(showId, movementStartedAt, events, 'unavailable', null,
      'Acoustic lookup failed; no trend was inferred.');
    return null;
  } // optional evidence cannot hold up the radio
}
