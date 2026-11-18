// Shared native-JS query policy: both the synchronous maintenance path and the
// worker use this exact implementation. The worker needs no TypeScript loader.
const EXCLUDE_WIDEN_K_FACTOR = 3;

/**
 * @param {import('better-sqlite3').Database} database
 * @param {Buffer} buf
 * @param {number} k
 * @param {string|null} excludeId
 * @param {'track_vectors'|'track_audio_vectors'} table
 * @param {ReadonlySet<string>|null|undefined} excludeIds
 * @returns {Array<{id: string, similarity: number}>}
 */
export function queryKnn(database, buf, k, excludeId, table, excludeIds) {
  const base = excludeId ? k + 1 : k;
  const want = excludeIds ? excludeIds.size : 0;
  const stmt = database.prepare(
    `SELECT id, distance FROM ${table} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
  );
  const run = limit => {
    const rows = stmt.all(buf, limit);
    const hits = [];
    for (const row of rows) {
      if (excludeId && row.id === excludeId) continue;
      if (excludeIds && excludeIds.has(row.id)) continue;
      hits.push({ id: row.id, similarity: 1 - row.distance });
      if (hits.length === k) break;
    }
    return hits;
  };
  const widened = Math.min(want, k * EXCLUDE_WIDEN_K_FACTOR);
  const hits = run(base + widened);
  if (hits.length < k && widened < want) return run(base + want);
  return hits;
}
