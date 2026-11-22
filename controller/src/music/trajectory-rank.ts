// Optional MI v2.5 shortlist assessment. Never admits a new ID and never
// supplies a playable item outside the caller's already-eligible candidates.
import { evaluateForwardPaths, orderWithForwardPaths, selectForwardPaths, type SonicPoint, type CandidateSonicPoint } from './trajectory-engine.js';

export interface TrajectoryCandidate {
  id?: string;
  artist?: string | null;
  musical_evidence?: {
    arousal?: { coverage?: string; mean?: number | null };
    valence?: { coverage?: string; mean?: number | null };
    danceable?: { status?: string; score?: number | null };
  } | null;
}
function deam(head: { coverage?: string; mean?: number | null } | null | undefined) {
  return head?.coverage === 'complete' && typeof head.mean === 'number'
    && Number.isFinite(head.mean) && head.mean >= 1 && head.mean <= 9
    ? Math.round((head.mean - 1) / 8 * 1000) / 1000 : null;
}
export function pointFromDiscovery(item: TrajectoryCandidate): SonicPoint {
  const e = item.musical_evidence;
  const d = e?.danceable;
  return { arousal: deam(e?.arousal), valence: deam(e?.valence),
    danceability: d?.status === 'complete' && typeof d.score === 'number'
      && Number.isFinite(d.score) && d.score >= 0 && d.score <= 1 ? d.score : null };
}
export function trajectoryRankCandidates<T extends TrajectoryCandidate>(
  candidates: readonly T[], predecessor: SonicPoint | null,
  direction: 'build' | 'release' | null,
  includeHints = false,
  movementIntent: 'contrast' | null = null,
): T[] {
  if (candidates.length < 3 || !predecessor) return [...candidates];
  const eligible: CandidateSonicPoint[] = candidates.slice(0, 24).filter(x => !!x.id)
    .map(x => ({ id: x.id!, artist: x.artist, ...pointFromDiscovery(x) }));
  const paths = evaluateForwardPaths(eligible, predecessor, direction);
  if (!paths.length) return [...candidates];
  const selectedPaths = selectForwardPaths(paths, movementIntent === 'contrast');
  const reordered = orderWithForwardPaths(candidates, selectedPaths);
  if (!includeHints) return reordered;
  const pathFor = new Map(selectedPaths.map(p => [p.firstId, p]));
  return reordered.map(track => {
    const p = pathFor.get(track.id ?? '');
    return !p ? track : { ...track, trajectory_option: {
      character: p.character, possibleNextId: p.possibleSecondId,
      evidenceDimensions: p.evidenceDimensions,
      note: 'Provisional two-step option among already discovered tracks; not queued or a musical quality rating.',
    } };
  });
}
