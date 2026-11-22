import { tool } from 'ai';
import { z } from 'zod';
import { completeDiscoveryMusicEvidence, sampledWindowEvidence } from '../../../../../music/music-evidence-profile.js';
import { lookupV2WithStatus } from '../../../../../music/essentia-evidence.js';
import { definePickerTool } from '../defs.js';

// Read-only *history*, not a candidate discovery source. The IDs must originate
// from a verified same-show on-air context. It does not add historical tracks
// to `seen`, so the Agent cannot choose an old song by calling this tool.
export default definePickerTool({
  name: 'inspectRecentMusicalArc',
  available: ({ scope, essentia }) => process.env.SUBWAVE_MI_EXPANDED_PICKER === '1'
    && process.env.SUBWAVE_MUSIC_EVIDENCE_V2 === '1'
    && scope.essentiaDiscovery === true && !!scope.selection?.predecessorId
    && !!essentia?.lookupV2,
  build: ctx => tool({
    description: 'Inspect the last verified same-show tracks (newest first), in pages of up to 4, with full Essentia label coverage and optional sparse temporal samples. This is HISTORY, not selectable candidates. Use it to understand an arc, boredom, continuity or intentional contrast; sampled windows are estimates, never complete song sections.',
    inputSchema: z.object({
      offset: z.number().int().min(0).optional(),
      pageSize: z.number().int().min(1).max(4).optional(),
      detail: z.enum(['summary', 'windows']).optional(),
    }),
    execute: async ({ offset = 0, pageSize = 4, detail = 'summary' }) => {
      const selection = ctx.scope.selection;
      const ids = selection ? [...new Set(selection.recentAiredIds)].slice(0, 12) : [];
      if (!ids.length) return { status: 'unavailable', reason: 'no_verified_same_show_history' };
      if (offset >= ids.length) return { status: 'invalid_page', total: ids.length };
      const page = ids.slice(offset, offset + pageSize);
      const pagination = { offset, total: ids.length, nextOffset: offset + page.length < ids.length
        ? offset + page.length : null };
      if (!ctx.essentia) return { status: 'unavailable', page: pagination };
      try {
        const response = await lookupV2WithStatus(ctx.essentia, page);
        if (response.status === 'transport_limit') return {
          status: 'transport_limit', boundary: response.boundary, page: pagination,
          note: 'Retry with pageSize=1; keep the same offset.',
        };
        if (response.status !== 'ok') return { status: 'unavailable', page: pagination };
        const tracks = page.map(id => {
          const evidence = response.rows.get(id);
          return evidence ? { id, musical_evidence: completeDiscoveryMusicEvidence(evidence),
            ...(detail === 'windows' ? { window_evidence: sampledWindowEvidence(evidence,
              ['arousal', 'valence', 'danceability', 'voice', 'timbre', 'instrument', 'mood'],
              { includeAllVerifiedLabels: true }) } : {}) } : { id, musical_evidence: null };
        });
        // The transport is physically bounded even in uncapped mode. Never
        // misreport too-large evidence as absent or consume memory unboundedly.
        if (Buffer.byteLength(JSON.stringify(tracks)) > 2 * 1024 * 1024) return {
          status: 'transport_limit', boundary: 'response', page: pagination,
          note: 'Retry a smaller page or summary detail.',
        };
        return { status: 'available', page: pagination, tracks,
          sampling: 'sparse_windows_not_continuous' };
      } catch { return { status: 'unavailable', page: pagination }; }
    },
  }),
});
