// Shared verified-only V2 index reader for director and picker. Source freshness
// remains enforced by the existing Essentia socket contract.
import { getEssentiaReader, lookupV2WithStatus, type EssentiaReader } from './essentia-evidence.js';
import type { MusicEvidenceV2 } from './musical-evidence-v2.js';

// Use the protocol's supported maximum for the fast path. Oversized responses
// and timeouts are split below, but ordinary full profiles stay one request.
const SOCKET_BATCH = 12;

/** Preserve coverage distinctions. Transport-limit retries split the SAME
 * verified IDs; transient contention is retried inside a strict deadline, and
 * a failed lookup never produces fabricated zero scores. */
export async function readVerifiedModelProfiles(
  ids: readonly string[], reader: EssentiaReader | null = getEssentiaReader(),
  maxElapsedMs = 8000,
): Promise<{ status: 'available' | 'partial' | 'unavailable';
  profiles: Map<string, MusicEvidenceV2>; incomplete: number; failures: Record<string, number> }> {
  const valid = [...new Set(ids.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 256))];
  const profiles = new Map<string, MusicEvidenceV2>();
  const failures: Record<string, number> = {};
  if ((!reader?.lookupV2 && !reader?.lookupV2Result) || !valid.length) {
    return { status: 'unavailable', profiles, incomplete: valid.length,
      failures: valid.length ? { reader_unavailable: valid.length } : {} };
  }
  let incomplete = 0;
  const deadline = Date.now() + Math.max(1000, Math.min(15000, maxElapsedMs));
  const fail = (reason: string, group: string[]) => {
    failures[reason] = (failures[reason] ?? 0) + group.length;
    incomplete += group.length;
  };
  const fetchBatch = async (group: string[], busyRetries = 0): Promise<void> => {
    if (Date.now() >= deadline) { fail('deadline', group); return; }
    let result;
    try {
      result = await lookupV2WithStatus(reader, group);
    } catch { fail('unknown', group); return; }
    if (result.status === 'ok') {
      for (const [id, row] of result.rows) if (group.includes(id)) profiles.set(id, row);
      const missing = group.filter(id => !result.rows.has(id));
      if (missing.length) fail('profile_missing', missing);
      return;
    }
    if (result.status === 'transport_limit' && group.length > 1) {
      const middle = Math.floor(group.length / 2);
      await fetchBatch(group.slice(0, middle));
      await fetchBatch(group.slice(middle));
      return;
    }
    if (result.status === 'unavailable' && result.reason === 'busy'
        && busyRetries < 6 && Date.now() + Math.min(250, 50 * (2 ** busyRetries)) < deadline) {
      // The reader allows two concurrent sockets and another read may occupy
      // one until its own 1s deadline. Bounded backoff avoids giving up before
      // that slot is normally released, without spinning or unbounded waiting.
      await new Promise(resolve => setTimeout(resolve, Math.min(250, 50 * (2 ** busyRetries))));
      await fetchBatch(group, busyRetries + 1);
      return;
    }
    // A timeout on a full batch can be caused by its payload/read cost. Retry
    // smaller exact-ID groups; a singleton timeout remains explicitly missing.
    if (result.status === 'unavailable' && result.reason === 'timeout' && group.length > 1) {
      const middle = Math.floor(group.length / 2);
      await fetchBatch(group.slice(0, middle));
      await fetchBatch(group.slice(middle));
      return;
    }
    fail(result.status === 'unavailable' ? result.reason : 'transport_limit', group);
  };
  for (let i = 0; i < valid.length; i += SOCKET_BATCH) await fetchBatch(valid.slice(i, i + SOCKET_BATCH));
  return { profiles, incomplete,
    failures,
    status: !profiles.size ? 'unavailable' : profiles.size === valid.length && !incomplete ? 'available' : 'partial' };
}
