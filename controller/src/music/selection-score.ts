// Pure experimental selection policy. No catalogue access or random draws.
import { bpmCompat, keyCompat, parseCamelot } from './mix.js';

export interface PaceWindow { startMs: number; endMs: number; value: number }
export interface AcousticEvidence {
  bpm?: number | null;
  beatEvidence?: 'reliable' | 'unknown' | 'beatless';
  keyStart?: string | null;
  keyEnd?: string | null;
  key?: string | null;
  pace?: readonly PaceWindow[] | null;
  vector?: ArrayLike<number> | null;
}
export interface SelectionScoreInput {
  enabled: boolean;
  sameShow: boolean;
  anchorReliable: boolean;
  predecessor: AcousticEvidence | null;
  recentAired: readonly AcousticEvidence[];
  candidate: AcousticEvidence;
  baselineRank: number;
  candidateCount: number;
  softBoundPlaylistMember?: boolean | null;
  // Only enabled by the full MI v2.5 gate. Old score bytes stay identical.
  coverageAware?: boolean;
  movementIntent?: 'build' | 'release' | 'hold' | 'contrast' | null;
}
export interface SelectionScore {
  baseline: number;
  pace: number | null;
  bpm: number | null;
  key: number | null;
  clapProximity: number | null;
  novelty: number | null;
  flow: number | null;
  confidence: number;
  utility: number;
}
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const validBpm = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

export function medianPace(spans: readonly PaceWindow[] | null | undefined): number | null {
  const values = (spans ?? []).filter(s => Number.isFinite(s.startMs) && Number.isFinite(s.endMs)
    && s.endMs - s.startMs >= 500 && Number.isFinite(s.value))
    .map(s => s.value).sort((a, b) => a - b);
  if (values.length < 3) return null;
  const m = Math.floor(values.length / 2);
  return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
}

// Returns mapped cosine similarity; null is missing/invalid evidence.
export function acousticSimilarity(a: ArrayLike<number> | null | undefined, b: ArrayLike<number> | null | undefined): number | null {
  if (!a || !b || !a.length || a.length !== b.length) return null;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return null;
    dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i];
  }
  if (!Number.isFinite(dot) || !Number.isFinite(aa) || !Number.isFinite(bb) || !aa || !bb) return null;
  return clamp((clampCos(dot / Math.sqrt(aa * bb)) + 1) / 2);
}
function clampCos(n: number): number { return Math.max(-1, Math.min(1, n)); }

export function scoreSelection(input: SelectionScoreInput): SelectionScore {
  const n = Math.max(1, Math.floor(Number.isFinite(input.candidateCount) ? input.candidateCount : 1));
  const rank = Math.max(0, Math.min(n - 1, Math.floor(Number.isFinite(input.baselineRank) ? input.baselineRank : 0)));
  const baseline = n === 1 ? 1 : (n - 1 - rank) / (n - 1);
  const result: SelectionScore = { baseline, pace: null, bpm: null, key: null, clapProximity: null, novelty: null, flow: null, confidence: 0, utility: baseline };
  if (!input.enabled) return result;
  const a = input.predecessor, b = input.candidate;
  if (input.sameShow && input.anchorReliable && a) {
    const pa = medianPace(a.pace), pb = medianPace(b.pace);
    if (pa != null && pb != null) result.pace = clamp(Math.exp(-Math.abs(pa - pb) / 0.04));
    if (validBpm(a.bpm) && validBpm(b.bpm)) result.bpm = clamp(bpmCompat(a.bpm, b.bpm));
    const ka = a.keyEnd ?? a.key ?? null, kb = b.keyStart ?? b.key ?? null;
    if (parseCamelot(ka) && parseCamelot(kb)) result.key = clamp(keyCompat(ka, kb));
    result.clapProximity = acousticSimilarity(a.vector, b.vector);
    // General analysis confidence is not a beat-confidence measure.
    const beatWeight = a.beatEvidence === 'reliable' && b.beatEvidence === 'reliable' ? 0.20 : 0.10;
    const terms: Array<[number | null, number]> = [[result.pace, 0.45], [result.bpm, beatWeight], [result.key, 0.15], [result.clapProximity, 0.20]];
    const present = terms.filter((t): t is [number, number] => t[0] != null);
    const weight = present.reduce((sum, t) => sum + t[1], 0);
    if (weight) result.flow = clamp(present.reduce((sum, [v, w]) => sum + v * w, 0) / weight);
    result.confidence = clamp(weight);
  }
  if (input.sameShow) {
    const similarities = input.recentAired.slice(0, 5).map(x => acousticSimilarity(x.vector, b.vector)).filter((v): v is number => v != null);
    if (similarities.length >= 2) result.novelty = clamp(1 - Math.max(...similarities));
  }
  const contrast = input.coverageAware === true && input.movementIntent === 'contrast';
  const flowWeight = result.flow == null ? 0
    : input.coverageAware === true
      ? (contrast ? 0.15 : 0.40) * result.confidence
      : 0.4;
  const noveltyWeight = result.novelty == null ? 0 : contrast ? 0.20 : 0.1;
  result.utility = clamp((1 - flowWeight - noveltyWeight) * baseline
    + flowWeight * (result.flow ?? 0) + noveltyWeight * (result.novelty ?? 0)
    + (input.softBoundPlaylistMember === true ? 0.08 : 0));
  return result;
}
