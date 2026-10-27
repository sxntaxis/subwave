/** A polarity inversion must be a gradual material-state change, not a one-frame
 * stripe phase flip. The easing is independent of the display refresh rate.
 */
export function advanceCrtPolarity(current: number, target: number, seconds: number): number {
  const value = Number.isFinite(current) ? Math.min(1, Math.max(0, current)) : 0;
  const destination = Number.isFinite(target) ? Math.min(1, Math.max(0, target)) : 0;
  const dt = Number.isFinite(seconds) ? Math.min(.1, Math.max(0, seconds)) : 0;
  return value + (destination - value) * (1 - Math.exp(-dt / .85));
}
