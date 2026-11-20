import { tool } from 'ai';
import { z } from 'zod';
import { compactMusicEvidence } from '../../../../../music/music-evidence-profile.js';
import { compareMusicalEvidence } from '../../../../../music/musical-evidence-v2.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'compareMusicalCandidates',
  available: ({ scope, essentia }) => scope.essentiaDiscovery === true
    && process.env.SUBWAVE_MUSIC_EVIDENCE_V2 === '1' && !!essentia?.lookupV2,
  build: ctx => tool({
    description: 'Compare 2–4 song IDs already returned by discovery. Evidence is estimated and based on sparse sampled windows; continuity and contrast can both be useful.',
    inputSchema: z.object({ ids: z.array(z.string().min(1).max(256)).min(2).max(4) }),
    execute: async ({ ids }) => {
      ctx.scope.essentiaAudit?.noteV2Compare?.();
      if (new Set(ids).size !== ids.length || ids.some(id => !ctx.seen.has(id))) {
        return { status: 'invalid_candidates', note: 'Use 2–4 distinct IDs already returned by discovery.' };
      }
      const reservation = ctx.reserveMusicEvidence(16 * 1024);
      if (!reservation || !ctx.essentia?.lookupV2) {
        return { status: 'unavailable', note: 'No comparison evidence budget remains.' };
      }
      let used = 0;
      try {
        const predecessorId = ctx.scope.selection?.predecessorId;
        const lookup = predecessorId && !ids.includes(predecessorId) ? [...ids, predecessorId] : ids;
        const rows = await ctx.essentia.lookupV2(lookup);
        if (!rows) return { status: 'unavailable', note: 'Music evidence is temporarily unavailable.' };
        const predecessor = predecessorId ? rows.get(predecessorId) ?? null : null;
        const found = ids.filter(id => rows.has(id)).length;
        const result = {
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
        used = Buffer.byteLength(JSON.stringify(result));
        if (used > reservation.bytes) {
          used = 0;
          return { status: 'unavailable', note: 'Comparison exceeds the remaining evidence budget.' };
        }
        return result;
      } catch {
        return { status: 'unavailable', note: 'Music evidence is temporarily unavailable.' };
      } finally {
        reservation.release(used);
      }
    },
  }),
});
