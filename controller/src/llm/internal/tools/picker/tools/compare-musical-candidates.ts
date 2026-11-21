import { tool } from 'ai';
import { z } from 'zod';
import {
  compactMusicEvidence, sampledWindowEvidence, type WindowDetailFamily,
} from '../../../../../music/music-evidence-profile.js';
import { compareMusicalEvidence } from '../../../../../music/musical-evidence-v2.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'compareMusicalCandidates',
  available: ({ scope, essentia }) => scope.essentiaDiscovery === true
    && process.env.SUBWAVE_MUSIC_EVIDENCE_V2 === '1' && !!essentia?.lookupV2,
  build: ctx => {
    const richEnabled = process.env.SUBWAVE_MUSIC_EVIDENCE_V2 === '1'
      && process.env.SUBWAVE_MUSIC_CONTEXT_V21 === '1';
    const idsSchema = z.array(z.string().min(1).max(256)).min(2).max(4);
    const familySchema = z.enum(['arousal', 'valence', 'danceability', 'voice', 'timbre', 'instrument', 'mood']);
    return tool({
      description: richEnabled
        ? 'Compare 2–4 already discovered song IDs. Optional detail=windows with selected families supplies sparse native samples for final-stage reasoning; no feature is a rule or calibrated probability.'
        : 'Compare 2–4 song IDs already returned by discovery. Evidence is estimated and based on sparse sampled windows; continuity and contrast can both be useful.',
      inputSchema: richEnabled
        ? z.object({ ids: idsSchema, detail: z.enum(['summary', 'windows']).optional(),
          families: z.array(familySchema).min(1).max(5).optional() })
        : z.object({ ids: idsSchema }),
      execute: async ({ ids, ...extra }) => {
        const requested = extra as { detail?: 'summary' | 'windows'; families?: WindowDetailFamily[] };
        try { ctx.scope.essentiaAudit?.noteV2Compare?.(); } catch { /* private audit is best-effort */ }
        try {
          ctx.scope.essentiaAudit?.captureV2Comparison?.({
            outcome: 'invoked', inputCount: ids.length, outputCount: 0,
          });
        } catch { /* private audit is best-effort */ }
        const observe = (outcome: 'success' | 'partial' | 'unavailable', outputCount: number) => {
          try {
            ctx.scope.essentiaAudit?.captureV2Comparison?.({
              outcome,
              inputCount: ids.length,
              outputCount,
            });
          } catch { /* private audit is best-effort */ }
        };
        if (new Set(ids).size !== ids.length || ids.some(id => !ctx.seen.has(id))) {
          observe('unavailable', 0);
          return { status: 'invalid_candidates', note: 'Use 2–4 distinct IDs already returned by discovery.' };
        }
        const reservation = ctx.reserveMusicEvidence(16 * 1024);
        if (!reservation || !ctx.essentia?.lookupV2) {
          observe('unavailable', 0);
          return { status: 'unavailable', note: 'No comparison evidence budget remains.' };
        }
        let used = 0;
        try {
          const predecessorId = ctx.scope.selection?.predecessorId;
          const lookup = predecessorId && !ids.includes(predecessorId) ? [...ids, predecessorId] : ids;
          const rows = await ctx.essentia.lookupV2(lookup);
          if (!rows) {
            observe('unavailable', 0);
            return { status: 'unavailable', note: 'Music evidence is temporarily unavailable.' };
          }
          const predecessor = predecessorId ? rows.get(predecessorId) ?? null : null;
          const found = ids.filter(id => rows.has(id)).length;
          const baseResult = {
            status: found === ids.length ? 'available' : found ? 'partial' : 'unavailable',
            candidates: ids.map(id => {
              const evidence = rows.get(id);
              return {
                id,
                musical_evidence: evidence ? compactMusicEvidence(evidence) : null,
                ...(predecessor && evidence ? { predecessor_comparison: compareMusicalEvidence(
                  predecessor, evidence, { sameShow: true, predecessorReliable: true, request: false },
                ) } : {}),
              };
            }),
          };
          let result: object = baseResult;
          if (richEnabled && requested.detail === 'windows') {
            const families = requested.families ?? ['arousal', 'valence'];
            const richResult = {
              ...baseResult,
              detail: 'windows',
              candidates: baseResult.candidates.map(candidate => ({
                ...candidate,
                ...(rows.get(candidate.id) ? {
                  window_evidence: sampledWindowEvidence(rows.get(candidate.id)!, families),
                } : {}),
              })),
            };
            // Detail may exceed the protected reservation. Downgrade the entire
            // result consistently; do not make an otherwise valid comparison
            // unavailable merely because optional depth does not fit.
            result = Buffer.byteLength(JSON.stringify(richResult)) <= reservation.bytes
              ? richResult : { ...baseResult, detail: 'summary_budget_fallback' };
          }
          used = Buffer.byteLength(JSON.stringify(result));
          if (used > reservation.bytes) {
            used = 0;
            observe('unavailable', 0);
            return { status: 'unavailable', note: 'Comparison exceeds the remaining evidence budget.' };
          }
          observe(found === ids.length ? 'success' : found ? 'partial' : 'unavailable', found);
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
