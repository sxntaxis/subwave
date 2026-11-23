import { deamSummary, type MusicEvidenceV2 } from './musical-evidence-v2.js';

interface HeadSummary {
  status: 'complete' | 'partial' | 'unavailable';
  observedWindows: number;
  expectedWindows: number;
  scores: Array<{ label: string; score: number }>;
}

// Each label is averaged only when it occurs once and is valid in every
// expected window. These are native uncalibrated model scores, not facts.
export function summarizeHead(evidence: MusicEvidenceV2, modelId: string): HeadSummary {
  const observed = new Map<string, number[]>();
  const seenWindows = new Set<number>();
  for (let i = 0; i < evidence.windows.length; i++) {
    const unique = new Set<string>();
    for (const output of evidence.windows[i].outputs) {
      if (output.modelId !== modelId || output.missingReason || output.validity !== 'valid'
          || output.nativeScale !== 'model native; see metadata'
          || typeof output.value !== 'number' || !Number.isFinite(output.value)
          || output.value < 0 || output.value > 1 || unique.has(output.label)) continue;
      unique.add(output.label);
      seenWindows.add(i);
      const values = observed.get(output.label) ?? [];
      values.push(output.value);
      observed.set(output.label, values);
    }
  }
  const expected = evidence.expectedWindows;
  const scores = [...observed.entries()]
    .filter(([, values]) => expected > 0 && values.length === expected && evidence.windows.length === expected)
    .map(([label, values]) => ({ label, score: Math.round(values.reduce((a, b) => a + b, 0) / values.length * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return {
    status: scores.length ? 'complete' : seenWindows.size ? 'partial' : 'unavailable',
    observedWindows: seenWindows.size, expectedWindows: expected, scores,
  };
}

export function compactMusicEvidence(evidence: MusicEvidenceV2) {
  const instrument = summarizeHead(evidence, 'mtg_jamendo_instrument-discogs-effnet-1');
  const mood = summarizeHead(evidence, 'mtg_jamendo_moodtheme-discogs-effnet-1');
  const dance = summarizeHead(evidence, 'danceability-discogs-effnet-1');
  const voice = summarizeHead(evidence, 'voice_instrumental-discogs-effnet-1');
  const timbre = summarizeHead(evidence, 'timbre-discogs-effnet-1');
  const scalar = (head: HeadSummary, label: string) => ({
    status: head.status, observedWindows: head.observedWindows, expectedWindows: head.expectedWindows,
    score: head.scores.find(item => item.label === label)?.score ?? null,
  });
  return {
    source: 'essentia_estimate' as const,
    scoreMeaning: 'native_uncalibrated_model_output' as const,
    windowSampling: 'sparse_windows_not_continuous' as const,
    instruments: { ...instrument, scores: instrument.scores.slice(0, 4) },
    moodThemes: { ...mood, scores: mood.scores.slice(0, 4) },
    danceable: scalar(dance, 'danceable'),
    voice: scalar(voice, 'voice'),
    brightTimbre: scalar(timbre, 'bright'),
    arousal: deamSummary(evidence, 'arousal'),
    valence: deamSummary(evidence, 'valence'),
  };
}

/**
 * v2.2 opt-in: retain every individually valid, trusted model label. Partial
 * labels carry their own observed-window counts; a sparse mean must never be
 * presented as though it described all expected samples.
 */
function summarizeHeadWithCoverage(evidence: MusicEvidenceV2, modelId: string) {
  const observed = new Map<string, number[]>();
  let windowsWithValidLabels = 0;
  for (const window of evidence.windows) {
    const outputsByLabel = new Map<string, typeof window.outputs[number][]>();
    for (const output of window.outputs) {
      if (output.modelId !== modelId) continue;
      const matches = outputsByLabel.get(output.label) ?? [];
      matches.push(output);
      outputsByLabel.set(output.label, matches);
    }
    let thisWindowValid = false;
    for (const [label, matches] of outputsByLabel) {
      if (matches.length !== 1) continue; // never treat duplicates as valid
      const output = matches[0];
      if (output.missingReason || output.validity !== 'valid'
          || output.nativeScale !== 'model native; see metadata'
          || typeof output.value !== 'number' || !Number.isFinite(output.value)
          || output.value < 0 || output.value > 1) continue;
      thisWindowValid = true;
      const values = observed.get(label) ?? [];
      values.push(output.value);
      observed.set(label, values);
    }
    if (thisWindowValid) windowsWithValidLabels++;
  }
  const expected = evidence.expectedWindows;
  const scores = [...observed.entries()].map(([label, values]) => ({
    label,
    score: Math.round(values.reduce((a, b) => a + b, 0) / values.length * 1000) / 1000,
    validWindows: values.length,
    expectedWindows: expected,
    coverage: expected > 0 && evidence.windows.length === expected && values.length === expected
      ? 'complete' as const : 'partial' as const,
  })).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return {
    status: scores.some(score => score.coverage === 'complete') ? 'complete' as const
      : scores.length ? 'partial' as const : 'unavailable' as const,
    observedWindows: windowsWithValidLabels,
    expectedWindows: expected,
    scores,
  };
}

/**
 * v2.2 discovery profile without editorial top-N trimming or token-share
 * allocation. No source paths, file stamps, hashes or raw output metadata.
 */
export function completeDiscoveryMusicEvidence(evidence: MusicEvidenceV2) {
  return {
    ...compactMusicEvidence(evidence),
    detail: 'verified_discovery' as const,
    instruments: summarizeHeadWithCoverage(evidence, 'mtg_jamendo_instrument-discogs-effnet-1'),
    moodThemes: summarizeHeadWithCoverage(evidence, 'mtg_jamendo_moodtheme-discogs-effnet-1'),
  };
}

/**
 * MI v3: the widest safe, model-facing interpretation of the verified V2 index.
 * Preserve ALL valid labels in each of the five classifier heads and the sparse
 * temporal readings for every scalar head. These are native, uncalibrated model
 * outputs; no audio vector, raw media, file identity or inferred prose is sent.
 */
export function maximalMusicEvidence(evidence: MusicEvidenceV2) {
  return {
    ...completeDiscoveryMusicEvidence(evidence),
    remainingModelHeads: {
      danceability: summarizeHeadWithCoverage(evidence, 'danceability-discogs-effnet-1'),
      voice: summarizeHeadWithCoverage(evidence, 'voice_instrumental-discogs-effnet-1'),
      timbre: summarizeHeadWithCoverage(evidence, 'timbre-discogs-effnet-1'),
    },
    sampledWindows: sampledWindowEvidence(evidence,
      ['arousal', 'valence', 'danceability', 'voice', 'timbre']),
  };
}

/** Model-side evidence is bounded only by the existing physical message envelope.
 * An oversized batch downgrades explicitly, never turns verified measurements
 * into fabricated absence or silently truncates an individual score array. */
export function attachMaximalMusicEvidence(
  tracks: readonly any[], evidence: ReadonlyMap<string, MusicEvidenceV2>,
) {
  const full = tracks.map(track => {
    const data = evidence.get(track?.id);
    return data ? { ...track, musical_evidence: maximalMusicEvidence(data) } : track;
  });
  if (Buffer.byteLength(JSON.stringify(full)) <= 2 * 1024 * 1024) return full;
  const summaries = tracks.map(track => {
    const data = evidence.get(track?.id);
    return data ? { ...track, musical_evidence: completeDiscoveryMusicEvidence(data),
      musical_evidence_detail: 'windows_transport_limit' as const } : track;
  });
  if (Buffer.byteLength(JSON.stringify(summaries)) <= 2 * 1024 * 1024) return summaries;
  return tracks.map(track => evidence.has(track?.id)
    ? { ...track, musical_evidence_status: 'physical_transport_limit_use_compare' as const }
    : track);
}

/**
 * Returns every verified profile for a bounded socket batch. Transport-size
 * failures are explicit, not misreported as missing Essentia evidence.
 */
export function attachCompleteMusicEvidence(tracks: readonly any[], evidence: ReadonlyMap<string, MusicEvidenceV2>) {
  const result = tracks.map(track => {
    const data = evidence.get(track?.id);
    return data ? { ...track, musical_evidence: completeDiscoveryMusicEvidence(data) } : track;
  });
  // This is a physical per-message guard, not a per-pick or per-song token
  // allowance. Further detail can be queried via the paged comparison tool.
  if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) {
    return tracks.map(track => evidence.has(track?.id)
      ? { ...track, musical_evidence_status: 'transport_limit_use_compare' as const }
      : track);
  }
  return result;
}

/**
 * A deliberately smaller discovery representation. The full verified profile
 * remains available to the shortlist comparison tool; nothing here is a
 * calibrated probability or a continuous description of the recording.
 */
export function briefDiscoveryMusicEvidence(evidence: MusicEvidenceV2) {
  const full = compactMusicEvidence(evidence);
  const scalar = (value: typeof full.voice) => ({ status: value.status, score: value.score });
  const endpoint = (value: typeof full.arousal) => ({
    opening: value.opening, ending: value.ending, coverage: value.coverage,
  });
  return {
    detail: 'discovery_brief' as const,
    source: full.source,
    scoreMeaning: full.scoreMeaning,
    windowSampling: full.windowSampling,
    arousal: endpoint(full.arousal),
    valence: endpoint(full.valence),
    danceable: scalar(full.danceable),
    voice: scalar(full.voice),
    brightTimbre: scalar(full.brightTimbre),
    instruments: { status: full.instruments.status, scores: full.instruments.scores.slice(0, 2) },
    moodThemes: { status: full.moodThemes.status, scores: full.moodThemes.scores.slice(0, 2) },
  };
}

/**
 * Allocate equal evidence-byte shares; optionally trade full profiles for a
 * truthful smaller discovery view if doing so improves candidate coverage.
 * Neither the input tracks nor the picker's canonical seen-map are modified.
 */
export function attachCompactMusicEvidence(
  tracks: readonly any[], evidence: ReadonlyMap<string, MusicEvidenceV2>, budgetBytes: number,
  options: { allowBriefFallback?: boolean } = {},
): { tracks: any[]; bytes: number } {
  if (!tracks.length || budgetBytes <= 0) return { tracks: [...tracks], bytes: 0 };
  const share = Math.floor(Math.min(8192, budgetBytes) / tracks.length);
  let bytes = 0;
  const out = tracks.map(track => {
    const data = evidence.get(track?.id);
    if (!data) return track;
    const profile = compactMusicEvidence(data);
    let size = Buffer.byteLength(JSON.stringify({ musical_evidence: profile }));
    while (size > share && (profile.instruments.scores.length || profile.moodThemes.scores.length)) {
      if (profile.instruments.scores.length) profile.instruments.scores.pop();
      if (profile.moodThemes.scores.length) profile.moodThemes.scores.pop();
      size = Buffer.byteLength(JSON.stringify({ musical_evidence: profile }));
    }
    if (size > share) return track;
    bytes += size;
    return { ...track, musical_evidence: profile };
  });
  // v2.1 opt-in only: when equal-sharing omits profiles, prefer a smaller
  // honest view for every eligible candidate over an all-or-nothing failure.
  // Never discard a successful full-profile allocation for fewer brief views.
  if (!options.allowBriefFallback || out.every((track, i) => !evidence.has(tracks[i]?.id) || track?.musical_evidence)) {
    return { tracks: out, bytes };
  }
  let briefBytes = 0;
  let briefCount = 0;
  const briefTracks = tracks.map(track => {
    const data = evidence.get(track?.id);
    if (!data) return track;
    const brief = briefDiscoveryMusicEvidence(data);
    let size = Buffer.byteLength(JSON.stringify({ musical_evidence: brief }));
    while (size > share && (brief.instruments.scores.length || brief.moodThemes.scores.length)) {
      if (brief.instruments.scores.length) brief.instruments.scores.pop();
      if (brief.moodThemes.scores.length) brief.moodThemes.scores.pop();
      size = Buffer.byteLength(JSON.stringify({ musical_evidence: brief }));
    }
    if (size > share) return track;
    briefBytes += size;
    briefCount++;
    return { ...track, musical_evidence: brief };
  });
  const fullCount = out.filter((track, i) => evidence.has(tracks[i]?.id) && !!track?.musical_evidence).length;
  return briefCount > fullCount ? { tracks: briefTracks, bytes: briefBytes } : { tracks: out, bytes };
}

// v2.1 optional shortlist evidence, never serialized in discovery. These
// correspond exactly to existing model heads and their native scales.
export type WindowDetailFamily =
  | 'arousal' | 'valence' | 'danceability' | 'voice' | 'timbre' | 'instrument' | 'mood';

const WINDOW_HEADS = {
  arousal: { model: 'deam-msd-musicnn-2', label: 'arousal', scale: 'DEAM native [1,9], valence then arousal', min: 1, max: 9 },
  valence: { model: 'deam-msd-musicnn-2', label: 'valence', scale: 'DEAM native [1,9], valence then arousal', min: 1, max: 9 },
  danceability: { model: 'danceability-discogs-effnet-1', label: 'danceable', scale: 'model native; see metadata', min: 0, max: 1 },
  voice: { model: 'voice_instrumental-discogs-effnet-1', label: 'voice', scale: 'model native; see metadata', min: 0, max: 1 },
  timbre: { model: 'timbre-discogs-effnet-1', label: 'bright', scale: 'model native; see metadata', min: 0, max: 1 },
} as const;

/**
 * Select only caller-requested native feature samples. Invalid/missing samples
 * remain explicit nulls; never interpolate sparse windows or manufacture
 * additional song sections. Caller must obtain only verified MusicEvidenceV2.
 */
export function sampledWindowEvidence(
  evidence: MusicEvidenceV2,
  families: readonly WindowDetailFamily[] = ['arousal', 'valence'],
  options: { includeAllVerifiedLabels?: boolean } = {},
) {
  const features: Record<string, unknown> = {};
  for (const family of new Set(families)) {
    if (family === 'instrument' || family === 'mood') {
      const model = family === 'instrument'
        ? 'mtg_jamendo_instrument-discogs-effnet-1'
        : 'mtg_jamendo_moodtheme-discogs-effnet-1';
      const summary = options.includeAllVerifiedLabels
        ? summarizeHeadWithCoverage(evidence, model) : summarizeHead(evidence, model);
      features[family] = {
        nativeScale: 'model native; see metadata',
        status: summary.status,
        observedWindows: summary.observedWindows,
        expectedWindows: summary.expectedWindows,
        returnedLabels: options.includeAllVerifiedLabels ? summary.scores.length : Math.min(8, summary.scores.length),
        availableLabels: summary.scores.length,
        scores: options.includeAllVerifiedLabels ? summary.scores : summary.scores.slice(0, 8),
      };
      continue;
    }
    const head = WINDOW_HEADS[family];
    if (!head) continue;
    let validWindows = 0;
    const samples = evidence.windows.map(window => {
      const found = window.outputs.filter(o => o.modelId === head.model && o.label === head.label);
      let value: number | null = null;
      let validity: 'valid' | 'missing' | 'invalid' = 'missing';
      let reason: string | null = 'missing_output';
      if (found.length > 1) {
        validity = 'invalid';
        reason = 'duplicate_output';
      } else if (found.length === 1) {
        const output = found[0];
        if (output.validity === 'valid' && !output.missingReason
          && output.nativeScale === head.scale && typeof output.value === 'number'
          && Number.isFinite(output.value) && output.value >= head.min && output.value <= head.max) {
          value = output.value;
          validity = 'valid';
          reason = null;
          validWindows++;
        } else {
          validity = 'invalid';
          reason = output.missingReason ? 'source_missing'
            : output.nativeScale !== head.scale ? 'scale_mismatch'
              : output.validity !== 'valid' ? 'model_invalid' : 'invalid_value';
        }
      }
      return {
        role: window.role, startMs: window.startMs, endMs: window.endMs,
        value, validity, ...(reason ? { reason } : {}),
      };
    });
    const complete = evidence.expectedWindows > 0
      && evidence.windows.length === evidence.expectedWindows
      && validWindows === evidence.expectedWindows;
    features[family] = {
      nativeScale: head.scale,
      coverage: complete ? 'complete' : validWindows ? 'partial' : 'unavailable',
      validWindows, expectedWindows: evidence.expectedWindows,
      samples,
    };
  }
  return {
    source: 'essentia_estimate' as const,
    scoreMeaning: 'native_uncalibrated_model_output' as const,
    windowSampling: 'sparse_windows_not_continuous' as const,
    returnedWindows: evidence.windows.length,
    expectedWindows: evidence.expectedWindows,
    features,
  };
}
