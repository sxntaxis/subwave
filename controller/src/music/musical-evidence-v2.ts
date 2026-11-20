// Music Intelligence v2: typed evidence, not editorial facts or a quality score.
// Raw model values are retained even when they are invalid for a derived view.
export interface ModelOutput {
  modelId: string;
  label: string;
  value: number | null;
  nativeScale: string | null;
  missingReason: string | null;
  validity?: string;
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
  dimensions?: {
    arousal: LabelComparison;
    valence: LabelComparison;
    instruments: InstrumentComparison;
    voice: LabelComparison;
    timbre: LabelComparison;
  };
}

interface EndpointCoverage {
  status: 'available' | 'partial' | 'unavailable';
  headPresent: boolean;
  labelPresent: boolean;
  validWindows: number;
  expectedWindows: number;
  endpointScore: number | null;
}

interface LabelComparison {
  label: string;
  status: 'available' | 'partial' | 'unavailable';
  predecessor: EndpointCoverage;
  candidate: EndpointCoverage;
  change: number | null;
}

interface InstrumentComparison {
  status: 'available' | 'partial' | 'unavailable';
  predecessorHead: EndpointCoverage;
  candidateHead: EndpointCoverage;
  labels: LabelComparison[];
}

const NATIVE_SCALE = 'model native; see metadata';
const INSTRUMENT_HEAD = 'mtg_jamendo_instrument-discogs-effnet-1';

function headEndpoint(evidence: MusicEvidenceV2, modelId: string, label: string | null,
  role: 'opening' | 'ending'): EndpointCoverage {
  let headPresent = false;
  let labelPresent = false;
  let validWindows = 0;
  let endpointScore: number | null = null;
  let endpointMatches = 0;
  for (const window of evidence.windows) {
    let validInWindow = false;
    for (const output of window.outputs) {
      if (output.modelId !== modelId) continue;
      headPresent = true;
      if (label !== null && output.label !== label) continue;
      labelPresent = true;
      const valid = output.validity === 'valid' && !output.missingReason
        && output.nativeScale === NATIVE_SCALE && typeof output.value === 'number'
        && Number.isFinite(output.value) && output.value >= 0 && output.value <= 1;
      if (!valid) continue;
      validInWindow = true;
      if (window.role === role && label !== null) {
        endpointMatches++;
        endpointScore = output.value;
      }
    }
    if (validInWindow) validWindows++;
  }
  if (endpointMatches !== 1) endpointScore = null;
  const status = label === null
    ? validWindows === evidence.expectedWindows && validWindows > 0 && evidence.windows.length === evidence.expectedWindows
      ? 'available' : headPresent ? 'partial' : 'unavailable'
    : endpointScore != null && validWindows === evidence.expectedWindows
      && evidence.expectedWindows > 0 && evidence.windows.length === evidence.expectedWindows
      ? 'available' : headPresent ? 'partial' : 'unavailable';
  return { status, headPresent, labelPresent: label === null ? headPresent : labelPresent,
    validWindows, expectedWindows: evidence.expectedWindows, endpointScore };
}

function compareLabel(predecessor: MusicEvidenceV2, candidate: MusicEvidenceV2,
  modelId: string, label: string): LabelComparison {
  const left = headEndpoint(predecessor, modelId, label, 'ending');
  const right = headEndpoint(candidate, modelId, label, 'opening');
  const change = left.endpointScore != null && right.endpointScore != null
    ? right.endpointScore - left.endpointScore : null;
  return { label, status: change != null && left.status === 'available' && right.status === 'available' ? 'available'
    : left.status === 'unavailable' && right.status === 'unavailable' ? 'unavailable' : 'partial',
  predecessor: left, candidate: right, change };
}

function deamEndpoint(evidence: MusicEvidenceV2, label: 'arousal' | 'valence',
  role: 'opening' | 'ending'): EndpointCoverage {
  const summary = deamSummary(evidence, label);
  const outputs = evidence.windows.flatMap(window => window.outputs)
    .filter(output => output.modelId === 'deam-msd-musicnn-2');
  const endpointScore = summary[role];
  return {
    status: endpointScore != null && summary.coverage === 'complete'
      ? 'available' : outputs.length ? 'partial' : 'unavailable',
    headPresent: outputs.length > 0,
    labelPresent: outputs.some(output => output.label === label),
    validWindows: summary.validWindows,
    expectedWindows: summary.expectedWindows,
    endpointScore,
  };
}

function compareDeam(predecessor: MusicEvidenceV2, candidate: MusicEvidenceV2,
  label: 'arousal' | 'valence'): LabelComparison {
  const left = deamEndpoint(predecessor, label, 'ending');
  const right = deamEndpoint(candidate, label, 'opening');
  const change = left.endpointScore != null && right.endpointScore != null
    ? right.endpointScore - left.endpointScore : null;
  return { label, status: change != null && left.status === 'available' && right.status === 'available' ? 'available'
    : left.status === 'unavailable' && right.status === 'unavailable' ? 'unavailable' : 'partial',
  predecessor: left, candidate: right, change };
}

function compareInstruments(predecessor: MusicEvidenceV2, candidate: MusicEvidenceV2): InstrumentComparison {
  const left = headEndpoint(predecessor, INSTRUMENT_HEAD, null, 'ending');
  const right = headEndpoint(candidate, INSTRUMENT_HEAD, null, 'opening');
  const labels = new Set<string>();
  for (const evidence of [predecessor, candidate]) {
    for (const window of evidence.windows) {
      for (const output of window.outputs) {
        if (output.modelId === INSTRUMENT_HEAD && /^[a-z]{1,32}$/.test(output.label)) labels.add(output.label);
      }
    }
  }
  const shared = [...labels].map(label => compareLabel(predecessor, candidate, INSTRUMENT_HEAD, label))
    .filter(item => item.change != null)
    .sort((a, b) => Math.max(b.predecessor.endpointScore!, b.candidate.endpointScore!)
      - Math.max(a.predecessor.endpointScore!, a.candidate.endpointScore!)
      || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, 4);
  return { status: shared.length && left.status === 'available' && right.status === 'available'
    && shared.every(item => item.status === 'available') ? 'available'
    : !left.headPresent && !right.headPresent ? 'unavailable' : 'partial',
  predecessorHead: left, candidateHead: right, labels: shared };
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
  if (!predecessor || !candidate || !context.sameShow || !context.predecessorReliable || context.request
      || predecessor.modelsHash !== candidate.modelsHash) return result;
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
  result.dimensions = {
    arousal: compareDeam(predecessor, candidate, 'arousal'),
    valence: compareDeam(predecessor, candidate, 'valence'),
    instruments: compareInstruments(predecessor, candidate),
    voice: compareLabel(predecessor, candidate, 'voice_instrumental-discogs-effnet-1', 'voice'),
    timbre: compareLabel(predecessor, candidate, 'timbre-discogs-effnet-1', 'bright'),
  };
  const available = Number(result.arousalChange != null) + Number(result.valenceChange != null);
  result.status = available === 2 ? 'available' : available === 1 ? 'partial' : 'unavailable';
  return result;
}
