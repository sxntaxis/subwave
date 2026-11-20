import { deamSummary, type MusicEvidenceV2 } from './musical-evidence-v2.js';

interface HeadSummary {
  status: 'complete' | 'partial' | 'unavailable';
  observedWindows: number;
  expectedWindows: number;
  scores: Array<{ label: string; score: number }>;
}

// Each label is averaged only when it occurs once and is valid in every
// expected window. These are native uncalibrated model scores, not facts.
function summarizeHead(evidence: MusicEvidenceV2, modelId: string): HeadSummary {
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
