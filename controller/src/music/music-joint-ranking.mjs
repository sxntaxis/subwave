// One contribution per requested family, with full evidence ahead of partial.
// Values are normalized within their own head; they are not probabilities.
export function compareJointResults(a, b) {
  return (a.tier === b.tier ? 0 : a.tier === 'full' ? -1 : 1)
    || b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function rankMusicCandidates(candidates, preferences, requiredFamilies = []) {
  if (!Array.isArray(candidates) || !Array.isArray(preferences) || !preferences.length
      || preferences.length > 32 || !Array.isArray(requiredFamilies)) return null;
  const families = new Map();
  for (const preference of preferences) {
    if (!preference || typeof preference.family !== 'string' || typeof preference.key !== 'string'
        || !['high', 'low'].includes(preference.direction)
        || (preference.weight != null && (!Number.isFinite(preference.weight) || preference.weight <= 0))) return null;
    const key = `${preference.family}\0${preference.key}\0${preference.direction}`;
    const group = families.get(preference.family) ?? new Map();
    if (!group.has(key)) group.set(key, preference);
    families.set(preference.family, group);
  }
  if (requiredFamilies.some(f => !families.has(f))) return null;
  const ranked = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || !candidate.values) continue;
    const contributions = [];
    let requestedCount = 0;
    let matchedCount = 0;
    let missingRequired = false;
    for (const [family, entries] of families) {
      const present = [];
      requestedCount += entries.size;
      for (const p of entries.values()) {
        const value = candidate.values[family]?.[p.key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) continue;
        present.push({ value: p.direction === 'low' ? 1 - value : value, weight: p.weight ?? 1 });
      }
      matchedCount += present.length;
      // Multiple requested labels in one family make up one bounded vote.
      if (present.length !== entries.size && requiredFamilies.includes(family)) missingRequired = true;
      if (!present.length) {
        continue;
      }
      const weight = present.reduce((sum, p) => sum + p.weight, 0);
      const mean = present.reduce((sum, p) => sum + p.value * p.weight, 0) / weight;
      contributions.push({ family, value: mean, weight: weight / present.length });
    }
    if (missingRequired || !contributions.length) continue;
    const complete = matchedCount === requestedCount;
    const totalWeight = contributions.reduce((sum, c) => sum + c.weight, 0);
    const score = contributions.some(c => c.value === 0) ? 0
      : Math.exp(contributions.reduce((sum, c) => sum + c.weight * Math.log(c.value), 0) / totalWeight);
    ranked.push({
      id: candidate.id, tier: complete ? 'full' : 'partial', score,
      evidenceCoverage: matchedCount / requestedCount,
      matchedPreferences: matchedCount, requestedPreferences: requestedCount,
    });
  }
  ranked.sort(compareJointResults);
  return ranked;
}
