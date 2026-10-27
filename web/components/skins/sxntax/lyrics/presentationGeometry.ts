/** Runtime layout arithmetic only; no transcript measurement participates. */
export function presentationHeight(normal: number, available: number, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  const eased = p * p * (3 - 2 * p);
  return normal + (available - normal) * eased;
}
