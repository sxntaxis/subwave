/**
 * Phosphoria P18: sound changes the existing blurred artwork's deformation and
 * optical grade. No orbiting artwork, zoom, radial waves or separate image layers.
 * Audio energy is a force; the established Kawarp shader remains the medium.
 * This pure model owns no audio, DOM or GPU resources.
 */
export interface MaterialControls {
  energyAttack: number;
  energyRelease: number;
  referenceAttack: number;
  referenceRelease: number;
  onsetThreshold: number;
  onsetRefractory: number;
  onsetDecay: number;
  warpAttack: number;
  warpRelease: number;
  emphasisAttack: number;
  emphasisRelease: number;
  contrastAttack: number;
  contrastRelease: number;
  saturationAttack: number;
  saturationRelease: number;
  handoffRelease: number;
  /** Maximum added strength applied to Kawarp's ORIGINAL domain warp. */
  warpStrength: number;
  /** Maximum extra foreground-only halo opacity, as a fraction. */
  textEmphasisStrength: number;
  /** Contrast increment around a midtone pivot, not zoom/scale. */
  contrastStrength: number;
  /** Colorfulness multiplier increment, preserving source hue. */
  saturationStrength: number;
}

export const PHOSPHORIA_MATERIAL: Readonly<MaterialControls> = Object.freeze({
  energyAttack: .12,
  energyRelease: .75,
  referenceAttack: 3.2,
  referenceRelease: 10.0,
  onsetThreshold: .095,
  onsetRefractory: .11,
  onsetDecay: .32,
  warpAttack: .10,
  warpRelease: .62,
  emphasisAttack: .085,
  emphasisRelease: .42,
  contrastAttack: .105,
  contrastRelease: .68,
  saturationAttack: .16,
  saturationRelease: .95,
  handoffRelease: 2.5,
  warpStrength: .44,
  textEmphasisStrength: .34,
  contrastStrength: .18,
  saturationStrength: .15,
});

export type MaterialSpectrum = {
  bass: number;
  mids: number;
  highs: number;
  overall: number;
  /** Positive changes in log-frequency magnitudes; not a BPM grid. */
  flux: number;
};

export type MaterialState = {
  time: number;
  reference: number;
  energy: number;
  transient: number;
  deformation: number;
  emphasis: number;
  contrast: number;
  saturation: number;
  handoff: number;
  fluxFloor: number;
  lastFlux: number;
  lastOnsetAt: number;
  onsetArmed: boolean;
  onsetCount: number;
};

const finite = (n: number, fallback = 0) => Number.isFinite(n) ? n : fallback;
const bound = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, finite(n)));
const follow = (old: number, target: number, dt: number, tau: number) => old + (target - old) * (1 - Math.exp(-dt / Math.max(tau, .001)));

export function createMaterialState(): MaterialState {
  return { time: 0, reference: .32, energy: 0, transient: 0,
    deformation: 0, emphasis: 0, contrast: 0, saturation: 0, handoff: 0,
    fluxFloor: 0, lastFlux: 0, lastOnsetAt: -10, onsetArmed: true, onsetCount: 0 };
}

/**
 * The slow reference is a contextual average, NOT an amplitude ceiling.
 * Normalising purely as loudness / reference made sustained music stick near 1,
 * which removed the musical dynamics the listener was meant to perceive.
 * A bounded absolute term preserves loud/quiet distinctions; a contextual term
 * gives quieter masters room to breathe and makes accents visible.
 */
export function relativeMusicalEnergy(loudness: number, reference: number): number {
  const level = bound(loudness);
  const baseline = Math.max(.18, bound(reference));
  const absolute = 1 - Math.exp(-level / .42);
  const relative = bound(.7 + .55 * (level - baseline) / baseline);
  return bound(.65 * absolute + .35 * relative);
}

/** Twelve logarithmic bands; no synthetic peaks when the analyser is absent. */
export function analyseMaterialSpectrum(
  bytes: Uint8Array | null,
  sampleRate: number | null,
  previousBands: readonly number[] | null,
): { spectrum: MaterialSpectrum; bands: number[] } | null {
  if (!bytes?.length || !sampleRate || sampleRate <= 0) return null;
  const hzPerBin = sampleRate / (2 * bytes.length);
  const bands: number[] = [];
  for (let b = 0; b < 12; b++) {
    const startHz = 45 * Math.pow(8500 / 45, b / 12);
    const endHz = 45 * Math.pow(8500 / 45, (b + 1) / 12);
    const from = Math.max(1, Math.ceil(startHz / hzPerBin));
    const to = Math.min(bytes.length, Math.max(from + 1, Math.ceil(endHz / hzPerBin)));
    let energy = 0;
    for (let i = from; i < to; i++) energy += (bytes[i] ?? 0) / 255;
    bands.push(energy / Math.max(1, to - from));
  }
  const mean = (from: number, to: number) => bands.slice(from, to).reduce((a, b) => a + b, 0) / (to - from);
  const bass = mean(0, 4), mids = mean(4, 8), highs = mean(8, 12);
  let flux = 0;
  if (previousBands?.length === 12) {
    for (let i = 0; i < 12; i++) flux += Math.max(0, (bands[i] ?? 0) - (previousBands[i] ?? 0));
    flux /= 12;
  }
  return { spectrum: { bass, mids, highs,
    overall: bound(bass * .45 + mids * .35 + highs * .20), flux: bound(flux * 3.0) }, bands };
}

export function advanceMaterial(
  previous: MaterialState,
  signal: MaterialSpectrum | null,
  elapsedSeconds: number,
  handoffIntensity = 0,
  controls: MaterialControls = PHOSPHORIA_MATERIAL,
): MaterialState {
  const dt = bound(elapsedSeconds, 0, .06);
  const time = previous.time + dt;
  const present = !!signal && Number.isFinite(signal.overall) && signal.overall > .005;
  const loudness = present ? bound(signal!.overall) : 0;
  // Slow reference normalization allows quiet masters to animate without
  // treating volume normalization itself as a percussive event.
  const reference = follow(previous.reference, Math.max(.22, loudness), dt,
    loudness > previous.reference ? controls.referenceAttack : controls.referenceRelease);
  const normalized = present ? relativeMusicalEnergy(loudness, reference) : 0;
  const energy = follow(previous.energy, normalized, dt,
    normalized > previous.energy ? controls.energyAttack : controls.energyRelease);
  const flux = present ? bound(signal!.flux) : 0;
  const fluxFloor = follow(previous.fluxFloor, flux, dt, 1.5);
  const excess = flux - previous.fluxFloor;
  const armed = previous.onsetArmed || !present || excess <= controls.onsetThreshold * .42;
  const rising = flux - previous.lastFlux > controls.onsetThreshold * .10;
  const onset = dt > 0 && present && armed && rising && excess > controls.onsetThreshold
    && time - previous.lastOnsetAt >= controls.onsetRefractory;
  const strike = onset ? bound((excess - controls.onsetThreshold) * 2.8) : 0;
  // The onset adds excitation to Kawarp's own deforming noise; NO wave emitters.
  const transient = Math.max(previous.transient * Math.exp(-dt / Math.max(.01, controls.onsetDecay)), strike);
  const handoff = follow(previous.handoff, bound(handoffIntensity), dt,
    handoffIntensity > previous.handoff ? .18 : controls.handoffRelease);
  const bassWeight = present ? bound(signal!.bass / (loudness + .15)) : 0;
  const deformationTarget = bound(energy * (.65 + bassWeight * .35) + transient * .44 + handoff * .12);
  const emphasisTarget = bound(energy * .70 + transient * .40 + handoff * .10);
  const contrastTarget = bound(energy * .82 + transient * .42 + handoff * .12);
  const saturationTarget = bound(energy * .67 + transient * .20 + handoff * .10);
  const ramp = (old: number, target: number, attack: number, release: number) =>
    follow(old, target, dt, target > old ? attack : release);
  return {
    time, reference, energy, transient,
    deformation: ramp(previous.deformation, deformationTarget, controls.warpAttack, controls.warpRelease),
    emphasis: ramp(previous.emphasis, emphasisTarget, controls.emphasisAttack, controls.emphasisRelease),
    contrast: ramp(previous.contrast, contrastTarget, controls.contrastAttack, controls.contrastRelease),
    saturation: ramp(previous.saturation, saturationTarget, controls.saturationAttack, controls.saturationRelease),
    handoff, fluxFloor, lastFlux: flux, lastOnsetAt: onset ? time : previous.lastOnsetAt,
    onsetArmed: onset ? false : armed, onsetCount: previous.onsetCount + Number(onset),
  };
}

/** Only deform and grade the existing image. No background brightness gain. */
export function materialUniforms(
  state: MaterialState, enabled = true, controls: MaterialControls = PHOSPHORIA_MATERIAL,
): [number, number, number] {
  if (!enabled) return [1, 1, 1];
  return [
    1 + bound(state.deformation) * controls.warpStrength,
    1 + bound(state.contrast) * controls.contrastStrength,
    1 + bound(state.saturation) * controls.saturationStrength,
  ];
}

/** Extra text-only halo amplitude in percentage points; never modifies artwork luminance. */
export function materialTextHalo(
  state: MaterialState, enabled = true, controls: MaterialControls = PHOSPHORIA_MATERIAL,
): number {
  return enabled ? bound(state.emphasis) * controls.textEmphasisStrength * 100 : 0;
}

/** Resume without generating false transients from a stale audio histogram. */
export function settleMaterialAfterVisibility(
  state: MaterialState, hiddenSeconds: number,
  controls: MaterialControls = PHOSPHORIA_MATERIAL,
): MaterialState {
  const capped = bound(hiddenSeconds, 0, 6);
  let next = state;
  const steps = Math.ceil(capped / .06);
  for (let i = 0; i < steps; i++) next = advanceMaterial(next, null, capped / steps, 0, controls);
  return next;
}
