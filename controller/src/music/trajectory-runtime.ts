// MI v2.5 runtime adapter. One bounded verified lookup and a tiny recent cache,
// never an LLM call or a second scheduler. Only actual starts form the history.
import { getEssentiaReader, lookupV2WithStatus } from './essentia-evidence.js';
import { measureTrajectory, sonicPoint, type AiredSonicPoint, type SonicPoint, type TrajectoryEnergy, type MeasuredTrajectory } from './trajectory-engine.js';

export const trajectoryEnabled = () => process.env.SUBWAVE_MUSIC_DIRECTION_V1 === '1'
  && process.env.SUBWAVE_MUSIC_DIRECTOR_V2 === '1'
  && process.env.SUBWAVE_MUSIC_TRAJECTORY_V1 === '1';
export interface VerifiedStart { eventId: string; showId: string | null; trackId: string | null }
type Cache = { key: string; expires: number; showId: string | null; movementStartedAt: string;
  predecessorId: string | null; predecessor: SonicPoint | null; measured: MeasuredTrajectory };
let cache: Cache | null = null;
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
  if (!trajectoryEnabled() || recent.length < 3) return null;
  const actual = recent.filter(s => s.showId === showId && s.trackId && s.eventId).slice(0, 8);
  if (actual.length < 3) return null;
  const key = JSON.stringify([showId, movementStartedAt, direction, actual.map(s => s.eventId)]);
  if (cache?.key === key && cache.expires > Date.now()) return cache.measured;
  const reader = getEssentiaReader();
  if (!reader?.lookupV2) return null;
  const ids = [...new Set(actual.map(s => s.trackId!))].slice(0, 8);
  try {
    const result = await lookupV2WithStatus(reader, ids);
    if (result.status !== 'ok') return null;
    const points: AiredSonicPoint[] = actual.map(s => ({ id: s.trackId!, eventId: s.eventId,
      ...(sonicPoint(result.rows.get(s.trackId!)) ?? { arousal: null, valence: null, danceability: null }) }));
    const measured = measureTrajectory(points, direction);
    cache = { key, expires: Date.now() + 45_000, showId, movementStartedAt,
      predecessorId: actual[0].trackId, predecessor: sonicPoint(result.rows.get(actual[0].trackId!)), measured };
    return measured;
  } catch { return null; } // optional evidence cannot hold up the radio
}
