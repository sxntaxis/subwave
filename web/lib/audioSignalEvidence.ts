export const AUDIO_SIGNAL_THRESHOLD_DBFS = -55;
export const AUDIO_SIGNAL_HOLD_MS = 200;
export const AUDIO_SIGNAL_MAX_SAMPLE_GAP_MS = 150;

export interface AudioSignalEvidence {
  sampleCount: number;
  minRmsDbfs: number | null;
  maxRmsDbfs: number | null;
  aboveSinceMs: number | null;
  lastSampleAtMs: number | null;
  detected: boolean;
  detectedAtMs: number | null;
}

export const EMPTY_AUDIO_SIGNAL_EVIDENCE: AudioSignalEvidence = {
  sampleCount: 0,
  minRmsDbfs: null,
  maxRmsDbfs: null,
  aboveSinceMs: null,
  lastSampleAtMs: null,
  detected: false,
  detectedAtMs: null,
};

/** RMS of decoded Float32 PCM samples, clamped to a finite silence floor. */
export function rmsDbfs(samples: ArrayLike<number>): number | null {
  if (samples.length === 0) return null;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (typeof sample !== 'number' || !Number.isFinite(sample)) return null;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120;
}

export function observeAudioSignal(
  previous: AudioSignalEvidence,
  rms: number | null,
  atMs: number,
  thresholdDbfs = AUDIO_SIGNAL_THRESHOLD_DBFS,
  holdMs = AUDIO_SIGNAL_HOLD_MS,
  maxSampleGapMs = AUDIO_SIGNAL_MAX_SAMPLE_GAP_MS,
): AudioSignalEvidence {
  if (rms == null || !Number.isFinite(rms) || !Number.isFinite(atMs) || previous.detected) return previous;
  const sampleGap = previous.lastSampleAtMs == null ? null : atMs - previous.lastSampleAtMs;
  const previousRunIsContinuous = sampleGap != null && sampleGap >= 0 && sampleGap <= maxSampleGapMs;
  const above = rms >= thresholdDbfs;
  const aboveSinceMs = above
    ? (previousRunIsContinuous ? previous.aboveSinceMs ?? atMs : atMs)
    : null;
  const detected = aboveSinceMs != null && atMs - aboveSinceMs >= holdMs;
  return {
    sampleCount: previous.sampleCount + 1,
    minRmsDbfs: previous.minRmsDbfs == null ? rms : Math.min(previous.minRmsDbfs, rms),
    maxRmsDbfs: previous.maxRmsDbfs == null ? rms : Math.max(previous.maxRmsDbfs, rms),
    aboveSinceMs,
    lastSampleAtMs: atMs,
    detected,
    detectedAtMs: detected ? atMs : null,
  };
}
