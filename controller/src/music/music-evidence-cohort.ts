// Exact bounded merge over eligible IDs. Never expose a partially searched
// cohort as a complete shortlist; the caller chooses the existing fallback.
import { compareJointResults } from './music-joint-ranking.mjs';
import type { JointEvidencePreference, JointEvidenceResult } from './essentia-evidence.js';

type Request = { preferences: JointEvidencePreference[]; eligibleIds: string[]; limit: number };
type Search = (request: Request) => Promise<JointEvidenceResult | null>;
export type CohortResult =
  | { status: 'complete'; results: JointEvidenceResult['results']; rankedCount: number; rejectedFreshness: number }
  | { status: 'incomplete'; reason: 'invalid_cohort' | 'deadline' | 'unavailable' | 'verification_limited' | 'invalid_result' };

export async function searchEligibleCohort(
  ids: readonly string[],
  preferences: JointEvidencePreference[],
  search: Search,
  deadlineMs: number,
  now: () => number = () => performance.now(),
): Promise<CohortResult> {
  if (new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !id || id.length > 256)) {
    return { status: 'incomplete', reason: 'invalid_cohort' };
  }
  if (!ids.length) return { status: 'complete', results: [], rankedCount: 0, rejectedFreshness: 0 };
  const all: JointEvidenceResult['results'] = [];
  let rankedCount = 0;
  let rejectedFreshness = 0;
  for (let offset = 0; offset < ids.length;) {
    if (now() >= deadlineMs) return { status: 'incomplete', reason: 'deadline' };
    const chunk: string[] = [];
    while (offset < ids.length && chunk.length < 128) {
      const trial = [...chunk, ids[offset]];
      const message = JSON.stringify({ version: 2, op: 'searchJoint', preferences, eligibleIds: trial, limit: 12 }) + '\n';
      if (Buffer.byteLength(message) > 32768) break;
      chunk.push(ids[offset++]);
    }
    if (!chunk.length) return { status: 'incomplete', reason: 'invalid_cohort' };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const remaining = Math.max(0, deadlineMs - now());
    const expired = Symbol('cohort deadline');
    const response = await Promise.race([
      search({ preferences, eligibleIds: chunk, limit: 12 }),
      new Promise<typeof expired>(resolve => { timeout = setTimeout(() => resolve(expired), remaining); }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (response === expired || now() >= deadlineMs) return { status: 'incomplete', reason: 'deadline' };
    if (!response) return { status: 'incomplete', reason: 'unavailable' };
    if (response.verificationLimited) return { status: 'incomplete', reason: 'verification_limited' };
    const allowed = new Set(chunk);
    const unique = new Set<string>();
    for (const row of response.results) {
      if (!allowed.has(row.id) || unique.has(row.id) || !['full', 'partial'].includes(row.tier)
          || !Number.isFinite(row.score) || row.score < 0 || row.score > 1) {
        return { status: 'incomplete', reason: 'invalid_result' };
      }
      unique.add(row.id);
      all.push(row);
    }
    rankedCount += response.rankedCount;
    rejectedFreshness += response.rejectedFreshness;
  }
  all.sort(compareJointResults);
  return { status: 'complete', results: all.slice(0, 12), rankedCount, rejectedFreshness };
}
