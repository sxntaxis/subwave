/** Runtime layout arithmetic only; no transcript measurement participates. */
export function presentationHeight(normal: number, available: number, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  const eased = p * p * (3 - 2 * p);
  return normal + (available - normal) * eased;
}

/** The view coordinator is the only corridor-height writer. Song choreography
 * may temporarily reserve an extent at the artwork endpoint; releasing it
 * must produce a concrete normal height, never remove the height property. */
export function ownedPresentationHeight(
  normal: number, available: number, progress: number,
  songHandoffActive: boolean, reservedHeight: number | null,
): number | null {
  if (progress === 0 && songHandoffActive) return reservedHeight;
  return presentationHeight(normal, available, progress);
}
