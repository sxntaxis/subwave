import { tool } from 'ai';
import { z } from 'zod';
import {
  compactMusicEvidence, completeDiscoveryMusicEvidence, maximalMusicEvidence, sampledWindowEvidence, type WindowDetailFamily,
} from '../../../../../music/music-evidence-profile.js';
import { compareMusicalEvidence } from '../../../../../music/musical-evidence-v2.js';
import { lookupV2WithStatus } from '../../../../../music/essentia-evidence.js';
import { definePickerTool } from '../defs.js';
import { trajectoryEnabled } from '../../../../../music/trajectory-runtime.js';

export default definePickerTool({
  name: 'compareMusicalCandidates',
  available: ({ scope, essentia }) => scope.essentiaDiscovery === true
    && (process.env.SUBWAVE_MUSIC_EVIDENCE_V2 === '1'
      || (trajectoryEnabled() && process.env.SUBWAVE_MI_DIRECTOR_V3 === '1'))
    && !!essentia?.lookupV2,
  build: ctx => {
    const maximalV3 = trajectoryEnabled() && process.env.SUBWAVE_MI_DIRECTOR_V3 === '1';
    const uncapped = maximalV3 || (process.env.SUBWAVE_MUSIC_EVIDENCE_V2 === '1'
      && process.env.SUBWAVE_MUSIC_CONTEXT_UNCAPPED === '1');
    const richEnabled = uncapped || (process.env.SUBWAVE_MUSIC_EVIDENCE_V2 === '1'
      && process.env.SUBWAVE_MUSIC_CONTEXT_V21 === '1');
    const idsSchema = z.array(z.string().min(1).max(256)).min(2).max(uncapped ? 12 : 4);
    const familySchema = z.enum(['arousal', 'valence', 'danceability', 'voice', 'timbre', 'instrument', 'mood']);
    return tool({
      description: uncapped
        ? 'Compare 2–12 previously discovered song IDs in explicitly paged groups of up to 4 (offset/pageSize). Return verified full labels and native sparse windows by default; use the next offset to examine remaining finalists. Missing data and partial coverage are not musical judgments.'
        : richEnabled
          ? 'Compare 2–4 already discovered song IDs. Optional detail=windows with selected families supplies sparse native samples for final-stage reasoning; no feature is a rule or calibrated probability.'
          : 'Compare 2–4 song IDs already returned by discovery. Evidence is estimated and based on sparse sampled windows; continuity and contrast can both be useful.',
      inputSchema: uncapped
        ? z.object({ ids: idsSchema, offset: z.number().int().min(0).optional(),
          pageSize: z.number().int().min(1).max(4).optional(),
          detail: z.enum(['summary', 'windows']).optional(),
          families: z.array(familySchema).min(1).max(7).optional() })
        : richEnabled
          ? z.object({ ids: idsSchema, detail: z.enum(['summary', 'windows']).optional(),
            families: z.array(familySchema).min(1).max(5).optional() })
          : z.object({ ids: idsSchema }),
      execute: async ({ ids, ...extra }) => {
        const requested = extra as { detail?: 'summary' | 'windows'; families?: WindowDetailFamily[];
          offset?: number; pageSize?: number };
        const offset = uncapped ? (requested.offset ?? 0) : 0;
        const pageSize = uncapped ? (requested.pageSize ?? 4) : ids.length;
        const pageIds = uncapped ? ids.slice(offset, offset + pageSize) : ids;
        const observedInputCount = uncapped ? pageIds.length : ids.length;
        const pagination = uncapped ? { offset, pageSize: pageIds.length, total: ids.length,
          hasMore: offset + pageIds.length < ids.length,
          nextOffset: offset + pageIds.length < ids.length ? offset + pageIds.length : null } : null;
        try { ctx.scope.essentiaAudit?.noteV2Compare?.(); } catch { /* private audit is best-effort */ }
        try {
          ctx.scope.essentiaAudit?.captureV2Comparison?.({
            outcome: 'invoked', inputCount: observedInputCount, outputCount: 0,
          });
        } catch { /* private audit is best-effort */ }
        const observe = (outcome: 'success' | 'partial' | 'unavailable', outputCount: number) => {
          try {
            ctx.scope.essentiaAudit?.captureV2Comparison?.({
              outcome,
              inputCount: observedInputCount,
              outputCount,
            });
          } catch { /* private audit is best-effort */ }
        };
        if (new Set(ids).size !== ids.length || ids.some(id => !ctx.seen.has(id))) {
          observe('unavailable', 0);
          return { status: 'invalid_candidates', note: uncapped
            ? 'Use 2–12 distinct IDs already returned by discovery.'
            : 'Use 2–4 distinct IDs already returned by discovery.' };
        }
        if (uncapped && (!Number.isInteger(offset) || offset < 0 || offset >= ids.length
            || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 4)) {
          observe('unavailable', 0);
          return { status: 'invalid_page', note: 'Choose a valid offset and pageSize of 1–4.' };
        }
        const reservation = uncapped
          ? { bytes: 2 * 1024 * 1024, release(_used: number) { /* physical result boundary */ } }
          : ctx.reserveMusicEvidence(16 * 1024);
        if (!reservation || !ctx.essentia?.lookupV2) {
          observe('unavailable', 0);
          return { status: 'unavailable', note: 'No comparison evidence budget remains.' };
        }
        let used = 0;
        try {
          const predecessorId = ctx.scope.selection?.predecessorId;
          const lookup = predecessorId && !pageIds.includes(predecessorId) ? [...pageIds, predecessorId] : pageIds;
          const lookupResult = uncapped ? await lookupV2WithStatus(ctx.essentia, lookup)
            : null;
          if (uncapped && lookupResult?.status === 'transport_limit') {
            observe('unavailable', 0);
            return { status: 'transport_limit', page: pagination,
              boundary: lookupResult.boundary,
              note: 'Physical socket envelope exceeded. Try fewer IDs per page; a single oversized profile may remain unavailable.' };
          }
          const rows = uncapped
            ? lookupResult?.status === 'ok' ? lookupResult.rows : null
            : await ctx.essentia.lookupV2(lookup);
          if (!rows) {
            observe('unavailable', 0);
            return { status: 'unavailable', note: 'Music evidence is temporarily unavailable.' };
          }
          const predecessor = predecessorId ? rows.get(predecessorId) ?? null : null;
          const found = pageIds.filter(id => rows.has(id)).length;
          const baseResult = {
            status: found === pageIds.length ? 'available' : found ? 'partial' : 'unavailable',
            ...(pagination ? { page: pagination } : {}),
            candidates: pageIds.map(id => {
              const evidence = rows.get(id);
              return {
                id,
                musical_evidence: evidence ? (uncapped
                  ? maximalV3 ? maximalMusicEvidence(evidence)
                    : completeDiscoveryMusicEvidence(evidence) : compactMusicEvidence(evidence)) : null,
                ...(predecessor && evidence ? { predecessor_comparison: compareMusicalEvidence(
                  predecessor, evidence, { sameShow: true, predecessorReliable: true, request: false },
                ) } : {}),
              };
            }),
          };
          let result: object = baseResult;
          if (richEnabled && (requested.detail ?? (uncapped ? 'windows' : 'summary')) === 'windows') {
            const families = requested.families ?? (uncapped
              ? ['arousal', 'valence', 'danceability', 'voice', 'timbre', 'instrument', 'mood'] as WindowDetailFamily[]
              : ['arousal', 'valence'] as WindowDetailFamily[]);
            const richResult = {
              ...baseResult,
              detail: 'windows',
              candidates: baseResult.candidates.map(candidate => ({
                ...candidate,
                ...(rows.get(candidate.id) ? {
                  window_evidence: sampledWindowEvidence(rows.get(candidate.id)!, families,
                    { includeAllVerifiedLabels: uncapped }),
                } : {}),
              })),
            };
            // Detail may exceed the protected reservation. Downgrade the entire
            // result consistently; do not make an otherwise valid comparison
            // unavailable merely because optional depth does not fit.
            result = Buffer.byteLength(JSON.stringify(richResult)) <= reservation.bytes
              ? richResult : uncapped ? { ...baseResult, detail: 'physical_transport_limit',
                note: 'Request fewer IDs on this page or fewer feature families to obtain windows.' }
                : { ...baseResult, detail: 'summary_budget_fallback' };
          }
          used = Buffer.byteLength(JSON.stringify(result));
          if (used > reservation.bytes) {
            used = 0;
            observe('unavailable', 0);
            return uncapped
              ? { status: 'transport_limit', page: pagination,
                note: 'Physical message boundary reached; request a smaller pageSize or fewer families.' }
              : { status: 'unavailable', note: 'Comparison exceeds the remaining evidence budget.' };
          }
          observe(found === pageIds.length ? 'success' : found ? 'partial' : 'unavailable', found);
          return result;
        } catch {
          observe('unavailable', 0);
          return { status: 'unavailable', note: 'Music evidence is temporarily unavailable.' };
        } finally {
          reservation.release(used);
        }
      },
    });
  },
});
