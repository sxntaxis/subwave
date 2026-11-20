// Music Intelligence v2: typed evidence, not editorial facts or a quality score.
// Raw model values are retained even when they are invalid for a derived view.
export interface ModelOutput {
  modelId: string;
  label: string;
  value: number | null;
  nativeScale: string | null;
  missingReason: string | null;
}

export interface EvidenceWindow {
  startMs: number;
  endMs: number;
  role: 'opening' | 'body' | 'ending';
  outputs: readonly ModelOutput[];
}

export interface MusicEvidenceV2 {
  trackId: string;
  analysisId: string;
  runId: string;
  modelsHash: string;
  sourceSize: string;
  sourceMtimeNs: string;
  expectedWindows: number;
  windows: readonly EvidenceWindow[];
}

export interface ScalarSummary {
  mean: number | null;
  min: number | null;
  max: number | null;
  opening: number | null;
  ending: number | null;
  validWindows: number;
  expectedWindows: number;
  invalidWindows: number;
  coverage: 'complete' | 'partial' | 'unavailable';
}

/** Only valid native 1–9 DEAM outputs participate; raw outliers remain intact. */
export function deamSummary(evidence: MusicEvidenceV2, label: 'arousal' | 'valence'): ScalarSummary {
  const valid: Array<{ role: EvidenceWindow['role']; value: number }> = [];
  let invalid = 0;
  for (const window of evidence.windows) {
    const matches = window.outputs.filter(o => o.modelId === 'deam-msd-musicnn-2' && o.label === label);
    if (matches.length !== 1) {
      if (matches.length > 1) invalid++;
      continue;
    }
    const o = matches[0];
    if (o.missingReason || o.nativeScale !== 'DEAM native [1,9], valence then arousal'
        || typeof o.value !== 'number' || !Number.isFinite(o.value) || o.value < 1 || o.value > 9) {
      invalid++;
      continue;
    }
    valid.push({ role: window.role, value: o.value });
  }
  const expected = evidence.expectedWindows;
  const values = valid.map(v => v.value);
  const complete = Number.isInteger(expected) && expected > 0
    && evidence.windows.length === expected && valid.length === expected && invalid === 0;
  return {
    mean: complete ? values.reduce((a, b) => a + b, 0) / values.length : null,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    opening: valid.find(v => v.role === 'opening')?.value ?? null,
    ending: valid.find(v => v.role === 'ending')?.value ?? null,
    validWindows: values.length,
    expectedWindows: expected,
    invalidWindows: invalid,
    coverage: complete ? 'complete' : values.length ? 'partial' : 'unavailable',
  };
}

export interface MusicalComparisonV2 {
  status: 'available' | 'partial' | 'unavailable';
  arousalChange: number | null;
  valenceChange: number | null;
  // Descriptive only: no continuity or contrast is treated as better.
  poolEssentiaDelta: 0;
}

/** Compare a verified predecessor ending to a verified candidate opening. */
export function compareMusicalEvidence(
  predecessor: MusicEvidenceV2 | null,
  candidate: MusicEvidenceV2 | null,
  context: { sameShow: boolean; predecessorReliable: boolean; request: boolean },
): MusicalComparisonV2 {
  const result: MusicalComparisonV2 = {
    status: 'unavailable', arousalChange: null, valenceChange: null, poolEssentiaDelta: 0,
  };
  if (!predecessor || !candidate || !context.sameShow || !context.predecessorReliable || context.request) return result;
  const arousalA = deamSummary(predecessor, 'arousal');
  const arousalB = deamSummary(candidate, 'arousal');
  const valenceA = deamSummary(predecessor, 'valence');
  const valenceB = deamSummary(candidate, 'valence');
  if (arousalA.ending != null && arousalB.opening != null) {
    result.arousalChange = arousalB.opening - arousalA.ending;
  }
  if (valenceA.ending != null && valenceB.opening != null) {
    result.valenceChange = valenceB.opening - valenceA.ending;
  }
  const available = Number(result.arousalChange != null) + Number(result.valenceChange != null);
  result.status = available === 2 ? 'available' : available === 1 ? 'partial' : 'unavailable';
  return result;
}
