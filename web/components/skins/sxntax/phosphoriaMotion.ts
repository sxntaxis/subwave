/**
 * Phosphoria's audio-to-fluid control model. There are no orbiting artwork
 * planes: a single analyser drives the existing Kawarp WebGL renderer.
 * Pure math, so the live-radio integration can be tested without media I/O.
 */
export type SpectralEnergy = {
  bass: number;
  mids: number;
  highs: number;
  overall: number;
};

export type AudioEnvelope = {
  baseline: number;
  level: number;
  pulse: number;
  initialized: boolean;
};

export type FluidControls = {
  attackSeconds: number;
  decaySeconds: number;
  baselineSeconds: number;
  /** Independent strengths, not a fixed orbital choreography. */
  warpStrength: number;
  flowStrength: number;
  colorStrength: number;
  scaleStrength: number;
  transientStrength: number;
  handoffStrength: number;
  /** Max React control commits/second; this does NOT limit Kawarp's WebGL FPS. */
  controlUpdateHz: number;
};

export const PHOSPHORIA_FLUID_CONTROLS: Readonly<FluidControls> = Object.freeze({
  attackSeconds: 0.075,
  decaySeconds: 0.75,
  baselineSeconds: 2.2,
  warpStrength: 1,
  flowStrength: 1,
  colorStrength: 1,
  scaleStrength: 1,
  transientStrength: 1,
  handoffStrength: 1,
  controlUpdateHz: 30,
});

export const EMPTY_AUDIO_ENVELOPE: AudioEnvelope = Object.freeze({
  baseline: 0, level: 0, pulse: 0, initialized: false,
});

const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
const clamp01 = (x: number) => clamp(x, 0, 1);
const approach = (from: number, to: number, dt: number, tau: number) =>
  from + (to - from) * (1 - Math.exp(-clamp(dt, 0, 0.2) / Math.max(0.001, tau)));

/** Frequency bins, not BPM. Bass and upper percussion are independently measured. */
export function spectralEnergy(bytes: Uint8Array | null, sampleRate: number | null): SpectralEnergy | null {
  if (!bytes?.length || !sampleRate || sampleRate <= 0) return null;
  const binHz = sampleRate / (2 * bytes.length);
  const accum: [number, number, number] = [0, 0, 0];
  const count: [number, number, number] = [0, 0, 0];
  for (let i = 1; i < bytes.length; i++) {
    const f = i * binHz;
    if (f < 45 || f >= 8500) continue;
    const band = f < 250 ? 0 : f < 1800 ? 1 : 2;
    accum[band] += (bytes[i] ?? 0) / 255;
    count[band] += 1;
  }
  const bass = count[0] ? accum[0] / count[0] : 0;
  const mids = count[1] ? accum[1] / count[1] : 0;
  const highs = count[2] ? accum[2] / count[2] : 0;
  const overall = clamp01(bass * 0.5 + mids * 0.35 + highs * 0.15);
  return { bass: clamp01(bass), mids: clamp01(mids), highs: clamp01(highs), overall };
}

export function advanceAudioEnvelope(
  previous: AudioEnvelope,
  energy: number | null,
  elapsedSeconds: number,
  controls: Pick<FluidControls, 'attackSeconds' | 'decaySeconds' | 'baselineSeconds'> = PHOSPHORIA_FLUID_CONTROLS,
): AudioEnvelope {
  const dt = clamp(elapsedSeconds, 0, 0.2);
  if (energy === null || !Number.isFinite(energy)) {
    return {
      ...previous,
      level: approach(previous.level, 0, dt, controls.decaySeconds),
      pulse: approach(previous.pulse, 0, dt, controls.decaySeconds),
      // Don't mistake a stale retained baseline for fresh audio.
      initialized: false,
    };
  }
  const target = clamp01(energy);
  if (!previous.initialized) return { baseline: target, level: target, pulse: 0, initialized: true };
  const baseline = approach(previous.baseline, target, dt, controls.baselineSeconds);
  const level = approach(previous.level, target, dt, target > previous.level ? controls.attackSeconds : controls.decaySeconds);
  // Relative onset, not BPM or a fabricated beat grid.
  const transient = clamp01(Math.max(0, target - baseline - 0.018) * 5.4);
  const pulse = approach(previous.pulse, transient, dt, transient > previous.pulse ? controls.attackSeconds : controls.decaySeconds);
  return { baseline, level, pulse, initialized: true };
}

export type FluidParameters = {
  warpIntensity: number;
  animationSpeed: number;
  saturation: number;
  scale: number;
};

/** Map audio envelopes to Kawarp-native shader props, preserving old defaults on signal loss. */
export function fluidParameters(
  baseAnimationSpeed: number,
  spectrum: SpectralEnergy | null,
  envelope: AudioEnvelope,
  handoffIntensity: number,
  controls: FluidControls = PHOSPHORIA_FLUID_CONTROLS,
): FluidParameters {
  const speed = clamp(baseAnimationSpeed, 0, 16);
  if (!spectrum || !envelope.initialized) {
    // Preserve the original Kawarp look at rest; the existing handoff still
    // gives the fluid a subtle surge even when Web Audio is unavailable.
    const handoff = clamp01(handoffIntensity) * controls.handoffStrength;
    return {
      warpIntensity: 1,
      animationSpeed: clamp(speed * (1 + 0.14 * handoff), 0, 16),
      saturation: 1.5,
      scale: 1 + 0.009 * handoff,
    };
  }
  const bass = clamp01(spectrum.bass);
  const mids = clamp01(spectrum.mids);
  const highs = clamp01(spectrum.highs);
  const level = clamp01(envelope.level);
  const pulse = clamp01(envelope.pulse) * controls.transientStrength;
  const handoff = clamp01(handoffIntensity) * controls.handoffStrength;
  return {
    // Broad bass displacement; percussive transient pressure; existing image field retained.
    warpIntensity: clamp(0.77 + controls.warpStrength * (0.13 * bass + 0.14 * pulse + 0.06 * handoff), 0, 1),
    // Kawarp retains its native requestAnimationFrame; only fluid drift speed changes.
    animationSpeed: clamp(speed * (1 + controls.flowStrength * (0.30 * level + 0.22 * mids + 0.28 * pulse + 0.18 * handoff)), 0, 16),
    saturation: clamp(1.5 + controls.colorStrength * (0.09 * level + 0.08 * highs + 0.09 * pulse), 0, 4),
    // A subtle pressure change, not a rotating/scaling artwork plane.
    scale: clamp(1 + controls.scaleStrength * (0.018 * bass + 0.018 * pulse + 0.009 * handoff), 0.01, 4),
  };
}

/** Only commit materially different values to the React wrapper. */
export function fluidParametersChanged(a: FluidParameters, b: FluidParameters): boolean {
  return Math.abs(a.warpIntensity - b.warpIntensity) > 0.006
    || Math.abs(a.animationSpeed - b.animationSpeed) > 0.012
    || Math.abs(a.saturation - b.saturation) > 0.012
    || Math.abs(a.scale - b.scale) > 0.004;
}
