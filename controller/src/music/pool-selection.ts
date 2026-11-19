// Compose ONLY the Pool's already-admitted shortlist. Never discover candidates here.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createSelectionAttempt } from '../llm/selection.js';
import { getSharedAcousticIndex, type IndexedAcousticRow } from './library-db/acoustic-index.js';
import { parseKeyRanges, parsePaceSpans } from './library-db/rows.js';
import { endingKeyFrom, openingKeyFrom } from './mix.js';
import { artistKey } from './recency.js';
import { scoreSelection, type AcousticEvidence } from './selection-score.js';
import { composeSelection } from './selection-compose.js';
import type { PickerSelectionObservation } from '../observability/picker-audit.js';

type Reader = (ids: readonly string[], timeoutMs: number) => Promise<IndexedAcousticRow[] | null>;
const fixture = new AsyncLocalStorage<Reader>();
export function withPoolAcousticReaderForTest<T>(reader: Reader, fn: () => T): T {
  return fixture.run(reader, fn);
}

export async function composePoolSelection<T extends { id?: string; artist?: string }>(
  baseline: T[],
  selection: { predecessorId: string; recentAiredIds: string[] } | undefined,
  observe?: (observation: PickerSelectionObservation) => void,
): Promise<T[]> {
  const report = (reason: PickerSelectionObservation['reason'], lookupMs?: number,
                  orderedShortlistChanged?: boolean) => {
    try { observe?.({ reason, eligibleCandidates: baseline.length, offeredCandidates: baseline.length,
      lookupMs, orderedShortlistChanged }); } catch {}
  };
  if (!selection || !baseline.length || baseline.some(c => !c.id)
      || new Set(baseline.map(c => c.id)).size !== baseline.length) {
    report('no_eligible_context');
    return baseline;
  }
  if (baseline.length > 256) {
    report('candidate_ceiling');
    return baseline;
  }
  const attempt = createSelectionAttempt();
  try {
    const reader = fixture.getStore();
    let index: ReturnType<typeof getSharedAcousticIndex> = null;
    try { if (!reader) index = getSharedAcousticIndex(); } catch { /* cold index */ }
    if (!reader && !index) { report('index_unavailable'); return baseline; }
    const lookup = await attempt.lookupObserved(
      baseline.map(c => c.id!), [selection.predecessorId, ...selection.recentAiredIds],
      (ids, timeout) => reader ? reader(ids, timeout) : index!.lookup(ids, timeout),
    );
    if (!lookup.rows) {
      report(lookup.reason === 'candidate_ceiling' ? 'candidate_ceiling'
        : lookup.reason === 'deadline_or_budget' ? 'deadline_or_budget'
          : lookup.reason === 'no_eligible_context' ? 'no_eligible_context' : 'index_unavailable', lookup.elapsedMs);
      return baseline;
    }
    const byId = new Map(lookup.rows.map(row => [row.id, row]));
    const evidence = (row: IndexedAcousticRow | undefined): AcousticEvidence | null => {
      if (!row?.track) return null;
      const t = row.track;
      const ranges = t.key_ranges_json ? parseKeyRanges(t.key_ranges_json) : null;
      return { bpm: t.bpm, key: t.musical_key, keyStart: openingKeyFrom(ranges, t.musical_key),
        keyEnd: endingKeyFrom(ranges, t.duration_sec == null ? null : t.duration_sec * 1000, t.musical_key),
        pace: t.pace_json ? parsePaceSpans(t.pace_json) : null, vector: row.vector };
    };
    const predecessor = evidence(byId.get(selection.predecessorId));
    if (!predecessor) { report('missing_predecessor_evidence', lookup.elapsedMs); return baseline; }
    const recentAired = selection.recentAiredIds.map(id => evidence(byId.get(id)))
      .filter((x): x is AcousticEvidence => x !== null);
    const ranked = baseline.map((value, i) => {
      const acoustic = evidence(byId.get(value.id!));
      const score = scoreSelection({ enabled: true, sameShow: true, anchorReliable: true,
        predecessor, recentAired, candidate: acoustic ?? {}, baselineRank: i, candidateCount: baseline.length });
      return { value, id: value.id!, artistKey: artistKey(value), baselineIndex: i,
        utility: score.utility, acoustic, flow: score.flow };
    });
    if (!ranked.some(item => item.flow !== null)) { report('missing_flow', lookup.elapsedMs); return baseline; }
    const composed = composeSelection(ranked, baseline.length, Infinity);
    if (composed.length !== baseline.length || new Set(composed.map(c => c.id)).size !== baseline.length) {
      report('scorer_exception', lookup.elapsedMs); return baseline;
    }
    const changed = composed.some((c, i) => c.id !== baseline[i].id);
    report('scored_no_membership_change', lookup.elapsedMs, changed);
    return composed;
  } catch {
    report('scorer_exception');
    return baseline;
  }
}
