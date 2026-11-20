import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import * as blocklist from '../../../../../music/blocklist.js';
import { searchEligibleCohort } from '../../../../../music/music-evidence-cohort.js';
import type { JointEvidencePreference } from '../../../../../music/essentia-evidence.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'findByAudioTraits',
  available: ({ essentia }) => essentia !== null,
  build: ctx => tool({
    description: 'Find tracks using estimated audio traits. Only freshly analysed tracks are searchable; other discovery tools still cover the whole library. Estimates are not editorial tags or guaranteed facts.',
    inputSchema: z.object({
      arousal: z.enum(['low', 'high']).optional(),
      valence: z.enum(['low', 'high']).optional(),
      danceability: z.enum(['low', 'high']).optional(),
      voice: z.enum(['voice', 'instrumental']).optional(),
      timbre: z.enum(['bright', 'dark']).optional(),
      mood: z.enum(['calm', 'dark', 'energetic', 'happy', 'melancholic', 'relaxing', 'sad', 'upbeat']).optional(),
      instrument: z.enum(['acousticguitar', 'drums', 'electricguitar', 'piano', 'saxophone', 'strings', 'synthesizer']).optional(),
    }),
    execute: async preferences => {
      ctx.scope.essentiaAudit?.noteTraitInvocation();
      if (!Object.values(preferences).some(Boolean)) {
        ctx.scope.essentiaAudit?.captureTraitResult([], 'empty');
        return ctx.emptyResult(0, 'choose at least one audio trait, or use another discovery tool');
      }
      try {
        let ids: string[] | null | undefined;
        if (ctx.scope.essentiaDiscovery && process.env.SUBWAVE_MUSIC_EVIDENCE_V2 === '1'
            && ctx.essentia?.searchJoint) {
          const requested: JointEvidencePreference[] = [];
          for (const family of ['arousal', 'valence', 'danceability'] as const) {
            if (preferences[family]) requested.push({ family, key: 'value', direction: preferences[family] });
          }
          if (preferences.voice) requested.push({ family: 'voice', key: 'value',
            direction: preferences.voice === 'voice' ? 'high' : 'low' });
          if (preferences.timbre) requested.push({ family: 'timbre', key: 'value',
            direction: preferences.timbre === 'bright' ? 'high' : 'low' });
          if (preferences.mood) requested.push({ family: 'mood', key: preferences.mood, direction: 'high' });
          if (preferences.instrument) requested.push({ family: 'instrument', key: preferences.instrument, direction: 'high' });
          const scope = ctx.scope;
          const constrained = !!(scope.playlistLock || scope.genreLock?.length || scope.eraLock?.length
            || scope.moodLock?.length || scope.energyLock?.length || scope.vocalLock
            || scope.minTrackSec || scope.excludedIds?.size);
          if (constrained) {
            // The SDK's tool execution timeout is 10s; reserve time to return a
            // safe incomplete result instead of letting it abort mid-search.
            const deadline = performance.now() + 8000;
            const cohort = await ctx.eligibleEvidenceIds(deadline);
            if (cohort.status !== 'complete') {
              ctx.scope.essentiaAudit?.captureTraitResult([], 'unavailable');
              return ctx.emptyResult(0, 'audio trait search could not finish the eligible show scope; use another discovery tool');
            }
            const result = await searchEligibleCohort(cohort.ids, requested, ctx.essentia.searchJoint, deadline);
            if (result.status !== 'complete') {
              ctx.scope.essentiaAudit?.captureTraitResult([], 'unavailable');
              return ctx.emptyResult(0, 'audio trait search could not finish the eligible show scope; use another discovery tool');
            }
            ids = result.results.map(row => row.id);
          } else {
            const result = await ctx.essentia.searchJoint({ preferences: requested, limit: 12 });
            ids = result && !result.verificationLimited
              ? result.results.map(row => row.id) : await ctx.essentia.search(preferences);
          }
        } else {
          ids = await ctx.essentia?.search(preferences);
        }
        if (!ids) {
          ctx.scope.essentiaAudit?.captureTraitResult([], 'unavailable');
          return ctx.emptyResult(0, 'audio trait evidence is temporarily unavailable; use another discovery tool');
        }
        await library.load();
        const list = blocklist.rejectBlocked(ids.slice(0, 128).map(id => library.slimById(id)).filter(Boolean));
        const tracks = await ctx.collectAsync(list);
        ctx.scope.essentiaAudit?.captureTraitResult(
          tracks.map(track => track?.id),
          tracks.length ? 'returned' : 'empty',
        );
        return tracks.length ? tracks : ctx.emptyResult(list.length, 'no available analysed tracks match; use another discovery tool');
      } catch {
        ctx.scope.essentiaAudit?.captureTraitResult([], 'error_or_timeout');
        return ctx.emptyResult(0, 'audio trait evidence is temporarily unavailable; use another discovery tool');
      }
    },
  }),
});
