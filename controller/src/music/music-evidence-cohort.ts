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

// Additive v2.2 cursor route for strict show/playlist cohorts. To return a
// GLOBAL page, each physical 128-ID chunk must contribute at least the first
// offset+limit verified hits. Taking only 12 per chunk would silently skip a
// high-ranked 13th song from a single chunk on page two.
export type PagedCohortResult =
  | { status: 'complete'; results: JointEvidenceResult['results']; rankedCount: number;
      rejectedFreshness: number; nextOffset: number | null; revision: string }
  | { status: 'incomplete'; reason:
      'invalid_cohort' | 'deadline' | 'unavailable' | 'verification_limited' | 'invalid_result' | 'stale' };

export async function searchEligibleCohortPage(
  ids: readonly string[], preferences: JointEvidencePreference[],
  search: (request: Request & { offset: number; revision?: string }) => Promise<JointEvidenceResult | null>,
  deadlineMs: number, offset = 0, limit = 12,
  expectedRevision?: string,
  now: () => number = () => performance.now(),
): Promise<PagedCohortResult> {
  const fail = (reason: Extract<PagedCohortResult, { status: 'incomplete' }>['reason']) =>
    ({ status: 'incomplete' as const, reason });
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000
      || !Number.isInteger(limit) || limit < 1 || limit > 12
      || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id || id.length > 256)) {
    return fail('invalid_cohort');
  }
  if (!ids.length) return { status: 'complete', results: [], rankedCount: 0,
    rejectedFreshness: 0, nextOffset: null, revision: expectedRevision ?? '' };
  const needed = offset + limit;
  const all: JointEvidenceResult['results'] = [];
  let revision: string | null = expectedRevision ?? null;
  let hasUnfetched = false;
  let rankedCount = 0;
  let rejectedFreshness = 0;
  for (let start = 0; start < ids.length;) {
    if (now() >= deadlineMs) return fail('deadline');
    const chunk: string[] = [];
    while (start < ids.length && chunk.length < 128) {
      const trial = [...chunk, ids[start]];
      // Every later physical page includes its revision and a potentially
      // wider offset. Reserve their maximum accepted wire widths up front so
      // a chunk fitting page one cannot overflow the socket on page two.
      if (Buffer.byteLength(JSON.stringify({ version: 2, op: 'searchJoint', preferences,
        eligibleIds: trial, limit: 12, offset: 1_000_000, revision: 'x'.repeat(128) }) + '\n') > 32768) break;
      chunk.push(ids[start++]);
    }
    if (!chunk.length) return fail('invalid_cohort');
    const allowed = new Set(chunk);
    const seen = new Set<string>();
    let localOffset = 0;
    let localRevision: string | undefined = revision ?? undefined;
    let counted = false;
    for (;;) {
      if (now() >= deadlineMs) return fail('deadline');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const expired = Symbol('cohort page deadline');
      const remaining = Math.max(0, deadlineMs - now());
      const response = await Promise.race([
        search({ preferences, eligibleIds: chunk, limit: 12, offset: localOffset,
          ...(localRevision ? { revision: localRevision } : {}) }),
        new Promise<typeof expired>(resolve => { timeout = setTimeout(() => resolve(expired), remaining); }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (response === expired || now() >= deadlineMs) return fail('deadline');
      if (!response) return fail('unavailable');
      if (response.status === 'stale') return fail('stale');
      if (response.status !== 'ok' || typeof response.revision !== 'string'
          || !/^[a-f0-9]{64}:\d+$/.test(response.revision)) return fail('invalid_result');
      if (revision != null && revision !== response.revision) return fail('stale');
      revision = response.revision;
      localRevision = revision;
      if (response.verificationLimited) return fail('verification_limited');
      if (!counted) { rankedCount += response.rankedCount; counted = true; }
      rejectedFreshness += response.rejectedFreshness;
      for (const row of response.results) {
        if (!allowed.has(row.id) || seen.has(row.id) || !['full', 'partial'].includes(row.tier)
            || !Number.isFinite(row.score) || row.score < 0 || row.score > 1) return fail('invalid_result');
        seen.add(row.id);
        all.push(row);
      }
      const next = response.nextOffset;
      if (next != null && (!Number.isInteger(next) || next <= localOffset || next > 1_000_000)) {
        return fail('invalid_result');
      }
      if (seen.size >= needed || next == null) {
        if (next != null) hasUnfetched = true;
        break;
      }
      localOffset = next;
    }
  }
  all.sort(compareJointResults);
  const page = all.slice(offset, offset + limit);
  const hasMore = hasUnfetched || all.length > offset + page.length;
  if (hasMore && !page.length) return fail('verification_limited');
  return { status: 'complete', results: page, rankedCount, rejectedFreshness,
    nextOffset: hasMore ? offset + page.length : null, revision: revision ?? '' };
}
