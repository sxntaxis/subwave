// MI v2.5: pure, bounded forward-looking evaluation of *verified* musical evidence.
// Musical estimates are never eligibility, quality, or a guarantee of how music sounds.
import { deamSummary, type MusicEvidenceV2 } from './musical-evidence-v2.js';
import { summarizeHead } from './music-evidence-profile.js';

export type TrajectoryEnergy = 'build' | 'release' | 'hold' | 'contrast' | null;
export interface SonicPoint {
  arousal: number | null;
  valence: number | null;
  danceability: number | null;
}
export interface AiredSonicPoint extends SonicPoint { id: string; eventId: string }
export interface CandidateSonicPoint extends SonicPoint { id: string; artist?: string | null }
export interface MeasuredTrajectory {
  status: 'measured' | 'insufficient';
  source: 'essentia_verified';
  observed: number;
  missing: number;
  // Only the explicitly measured arousal axis supports build/release progress.
  arousal: { latest: number; change: number; alignment: 'aligned' | 'diverging' | 'level' } | null;
  valenceChange: number | null;
  danceabilityChange: number | null;
  note: string;
}
export interface TrajectoryPath {
  firstId: string;
  possibleSecondId: string;
  character: 'continuity' | 'contrast';
  evidenceDimensions: number;
  // Uncalibrated comparison among candidates, NOT a likelihood or song rating.
  relativeUtility: number;
}
const unit = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 1000) / 1000;
const scalar = (x: unknown): number | null => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1 ? x : null;
const rounded = (v: number) => Math.round(v * 1000) / 1000;

/** Complete windows only; no mixing partial recordings into apparent trends. */
export function sonicPoint(row: MusicEvidenceV2 | null | undefined): SonicPoint | null {
  if (!row || !Array.isArray(row.windows)) return null;
  const a = deamSummary(row, 'arousal');
  const v = deamSummary(row, 'valence');
  const d = summarizeHead(row, 'danceability-discogs-effnet-1');
  const danceable = d.status === 'complete' ? d.scores.find(x => x.label === 'danceable')?.score : null;
  const result: SonicPoint = {
    arousal: a.coverage === 'complete' && a.mean != null ? unit((a.mean - 1) / 8) : null,
    valence: v.coverage === 'complete' && v.mean != null ? unit((v.mean - 1) / 8) : null,
    danceability: scalar(danceable),
  };
  return result.arousal === null && result.valence === null && result.danceability === null ? null : result;
}

/** The latest known *actual* starts, newest first; never speculative queue items. */
export function measureTrajectory(
  aired: readonly AiredSonicPoint[], energy: TrajectoryEnergy,
): MeasuredTrajectory {
  const unique = new Set<string>();
  const observations = aired.slice(0, 8).filter(p => {
    if (!p.eventId || unique.has(p.eventId)) return false;
    unique.add(p.eventId);
    return true;
  });
  const known = observations.filter(p => p.arousal !== null || p.valence !== null || p.danceability !== null);
  const delta = (field: keyof SonicPoint): number | null => {
    const pairs = observations.filter(p => p[field] !== null);
    return pairs.length < 3 || pairs[0][field] === null || pairs[pairs.length - 1][field] === null
      ? null : rounded(pairs[0][field]! - pairs[pairs.length - 1][field]!);
  };
  const arousalChange = delta('arousal');
  const arousalLatest = observations.find(p => p.arousal !== null)?.arousal ?? null;
  let alignment: NonNullable<MeasuredTrajectory['arousal']>['alignment'] = 'level';
  if (arousalChange !== null && Math.abs(arousalChange) >= 0.065) {
    const sign = energy === 'release' ? -1 : 1;
    alignment = energy === 'build' || energy === 'release'
      ? arousalChange * sign > 0 ? 'aligned' : 'diverging' : 'level';
  }
  const measured = arousalChange !== null && arousalLatest !== null;
  return {
    status: measured ? 'measured' : 'insufficient', source: 'essentia_verified',
    observed: known.length, missing: observations.length - known.length,
    arousal: measured ? { latest: rounded(arousalLatest!), change: arousalChange!, alignment } : null,
    valenceChange: delta('valence'), danceabilityChange: delta('danceability'),
    note: measured ? 'Measured acoustic trend only; textual destination, artistic intent and completion remain editorial.'
      : 'Insufficient complete evidence; do not infer stagnation, success or a missed destination.',
  };
}

function sharedDistance(a: SonicPoint, b: SonicPoint): { distance: number; dimensions: number } | null {
  const keys: (keyof SonicPoint)[] = ['arousal', 'valence', 'danceability'];
  const d = keys.filter(k => a[k] !== null && b[k] !== null).map(k => Math.abs(a[k]! - b[k]!));
  if (d.length < 2) return null; // one scalar cannot establish a musical trajectory
  return { distance: rounded(d.reduce((x, y) => x + y, 0) / d.length), dimensions: d.length };
}

/** Evaluate two plausible next-two-song paths. They are NOT reservations. */
export function evaluateForwardPaths(
  candidates: readonly CandidateSonicPoint[],
  predecessor: SonicPoint | null,
  energy: TrajectoryEnergy,
): TrajectoryPath[] {
  if (!predecessor || candidates.length < 3 || candidates.length > 24) return [];
  const seen = new Set<string>();
  const usable = candidates.filter(c => {
    if (!c.id || seen.has(c.id)) return false;
    seen.add(c.id);
    return sharedDistance(predecessor, c) !== null;
  });
  if (usable.length < 3) return [];
  const paths: TrajectoryPath[] = [];
  for (const character of ['continuity', 'contrast'] as const) {
    let winner: TrajectoryPath | null = null;
    for (const first of usable) {
      const firstDist = sharedDistance(predecessor, first)!;
      for (const second of usable) {
        if (first.id === second.id || (first.artist && second.artist
          && first.artist.toLowerCase() === second.artist.toLowerCase())) continue;
        const secondDist = sharedDistance(first, second);
        if (!secondDist) continue;
        const transition = character === 'continuity'
          ? 1 - Math.abs(firstDist.distance - 0.22) - Math.abs(secondDist.distance - 0.22)
          : Math.min(1, firstDist.distance + secondDist.distance) - 0.35 * Math.abs(firstDist.distance - secondDist.distance);
        const trend = energy === 'build' || energy === 'release'
          ? first.arousal !== null && second.arousal !== null && predecessor.arousal !== null
            ? (energy === 'build' ? 1 : -1) * (second.arousal - predecessor.arousal) : 0
          : 0;
        const relativeUtility = rounded(Math.max(-2, Math.min(2, transition + 0.2 * trend)));
        if (!winner || relativeUtility > winner.relativeUtility
          || relativeUtility === winner.relativeUtility && `${first.id}\0${second.id}` < `${winner.firstId}\0${winner.possibleSecondId}`) {
          winner = { firstId: first.id, possibleSecondId: second.id, character,
            evidenceDimensions: Math.min(firstDist.dimensions, secondDist.dimensions), relativeUtility };
        }
      }
    }
    if (winner) paths.push(winner);
  }
  return paths;
}

/** One canonical path per first ID. The displayed explanation must describe
 * the SAME proposal whose utility affected shortlist ordering. */
export function selectForwardPaths(
  paths: readonly TrajectoryPath[], preferContrast = false,
): TrajectoryPath[] {
  const selected = new Map<string, TrajectoryPath>();
  for (const path of paths) {
    const prior = selected.get(path.firstId);
    if (!prior || (preferContrast && prior.character !== 'contrast' && path.character === 'contrast')) {
      selected.set(path.firstId, path);
    }
  }
  return [...selected.values()];
}

/** Soft optional path utility. Original order retains at least 88% influence. */
export function orderWithForwardPaths<T extends { id?: string }>(
  candidates: readonly T[], paths: readonly TrajectoryPath[], weight = 0.12,
): T[] {
  if (candidates.length < 2 || !paths.length) return [...candidates];
  const boundedWeight = Math.min(0.12, Math.max(0, Number.isFinite(weight) ? weight : 0));
  const bonus = new Map<string, number>();
  for (const p of paths) if (!bonus.has(p.firstId)) bonus.set(p.firstId, unit((p.relativeUtility + 2) / 4));
  const n = candidates.length;
  return candidates.map((c, index) => ({ c, index,
    score: (1 - boundedWeight) * (n - 1 - index) / (n - 1) + boundedWeight * (bonus.get(c.id ?? '') ?? (n - 1 - index) / (n - 1)),
  })).sort((a, b) => b.score - a.score || a.index - b.index).map(x => x.c);
}
