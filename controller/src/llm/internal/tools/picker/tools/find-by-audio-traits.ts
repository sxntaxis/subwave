import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import * as blocklist from '../../../../../music/blocklist.js';
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
        const ids = await ctx.essentia?.search(preferences);
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
