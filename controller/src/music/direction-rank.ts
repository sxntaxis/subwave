// MI v2.3. Direction-aware ordering on already eligible, already surfaced
// discovery candidates. Model estimates are *soft evidence*, not authority.
export type EnergyDirection = 'build' | 'release';

export function orderByArousalDirection<T extends { musical_evidence?: any }>(
  items: readonly T[], direction: EnergyDirection | null,
): T[] {
  if (!direction || items.length < 2) return [...items];
  const scored = items.map((item, i) => {
    const head = item?.musical_evidence?.arousal;
    // Partial sampling cannot justify a numeric direction comparison.
    const value = head?.coverage === 'complete' && typeof head.mean === 'number'
      && Number.isFinite(head.mean) && head.mean >= 1 && head.mean <= 9
      ? (head.mean - 1) / 8 : null;
    return { item, i, value };
  });
  if (scored.filter(s => s.value !== null).length < 2) return [...items];
  const n = items.length;
  const utility = (s: typeof scored[number]) => {
    const baseline = n === 1 ? 1 : (n - 1 - s.i) / (n - 1);
    if (s.value === null) return baseline;
    const aim = direction === 'build' ? s.value : 1 - s.value;
    // 16% maximum influence; never converts an inferred profile into a hard
    // filter, never introduces a new track, and keeps base randomness relevant.
    return baseline * 0.84 + aim * 0.16;
  };
  return scored.sort((a,b) => utility(b)-utility(a) || a.i-b.i).map(s=>s.item);
}
