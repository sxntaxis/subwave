// Shared verified-only V2 index reader for director and picker. Source freshness
// remains enforced by the existing Essentia socket contract.
import { getEssentiaReader, lookupV2WithStatus, type EssentiaReader } from './essentia-evidence.js';
import type { MusicEvidenceV2 } from './musical-evidence-v2.js';

const SOCKET_BATCH = 12;

/** Preserve coverage distinctions. Transport-limit retries split the SAME
 * verified IDs; a failed lookup never produces fabricated zero scores. */
export async function readVerifiedModelProfiles(
  ids: readonly string[], reader: EssentiaReader | null = getEssentiaReader(),
  maxElapsedMs = 5000,
): Promise<{ status: 'available' | 'partial' | 'unavailable';
  profiles: Map<string, MusicEvidenceV2>; incomplete: number }> {
  const valid = [...new Set(ids.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 256))];
  const profiles = new Map<string, MusicEvidenceV2>();
  if ((!reader?.lookupV2 && !reader?.lookupV2Result) || !valid.length) return { status: 'unavailable', profiles, incomplete: valid.length };
  let incomplete = 0;
  const deadline = Date.now() + Math.max(1000, Math.min(15000, maxElapsedMs));
  const fetchBatch = async (group: string[]): Promise<void> => {
    if (Date.now() >= deadline) { incomplete += group.length; return; }
    try {
      const result = await lookupV2WithStatus(reader, group);
      if (result.status === 'ok') {
        for (const [id, row] of result.rows) if (group.includes(id)) profiles.set(id, row);
        return;
      }
      if (result.status === 'transport_limit' && group.length > 1) {
        const middle = Math.floor(group.length / 2);
        await fetchBatch(group.slice(0, middle));
        await fetchBatch(group.slice(middle));
        return;
      }
    } catch { /* unavailable stays explicitly unknown */ }
    incomplete += group.length;
  };
  for (let i = 0; i < valid.length; i += SOCKET_BATCH) await fetchBatch(valid.slice(i, i + SOCKET_BATCH));
  return { profiles, incomplete,
    status: !profiles.size ? 'unavailable' : profiles.size === valid.length && !incomplete ? 'available' : 'partial' };
}
