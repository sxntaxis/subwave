import { tool } from 'ai';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import * as blocklist from '../../../../../music/blocklist.js';
import { searchEligibleCohort, searchEligibleCohortPage } from '../../../../../music/music-evidence-cohort.js';
import type { JointEvidencePreference } from '../../../../../music/essentia-evidence.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'findByAudioTraits',
  available: ({ essentia }) => essentia !== null,
  build: ctx => {
    const expanded = process.env.SUBWAVE_MI_EXPANDED_PICKER === '1'
      && process.env.SUBWAVE_MUSIC_EVIDENCE_V2 === '1' && ctx.scope.essentiaDiscovery === true;
    const cursorKey = (preferences: JointEvidencePreference[], cohort?: readonly string[]) => createHash('sha256')
      .update(JSON.stringify({ preferences, cohort: cohort ?? null })).digest('hex');
    return tool({
    description: expanded
      ? 'Search the verified audio-trait ranking across the library or strict show cohort. Results are pages of at most 12 tracks; when nextCursor exists, reuse the SAME audio preferences with that cursor to continue. A stale cursor means restart at page one. Only freshly verified tracks are returned; model scores are not probabilities.'
      : 'Find tracks using estimated audio traits. Only freshly analysed tracks are searchable; other discovery tools still cover the whole library. Estimates are not editorial tags or guaranteed facts.',
    inputSchema: z.object({
      arousal: z.enum(['low', 'high']).optional(),
      valence: z.enum(['low', 'high']).optional(),
      danceability: z.enum(['low', 'high']).optional(),
      voice: z.enum(['voice', 'instrumental']).optional(),
      timbre: z.enum(['bright', 'dark']).optional(),
      mood: z.enum(['calm', 'dark', 'energetic', 'happy', 'melancholic', 'relaxing', 'sad', 'upbeat']).optional(),
      instrument: z.enum(['acousticguitar', 'drums', 'electricguitar', 'piano', 'saxophone', 'strings', 'synthesizer']).optional(),
      ...(expanded ? { cursor: z.object({ offset: z.number().int().min(1).max(1_000_000),
        revision: z.string().regex(/^[a-f0-9]{64}:\d+$/),
        queryKey: z.string().regex(/^[a-f0-9]{64}$/) }).optional() } : {}),
    }),
    execute: async preferences => {
      ctx.scope.essentiaAudit?.noteTraitInvocation();
      const cursor = expanded ? (preferences as { cursor?: { offset: number; revision: string; queryKey: string } }).cursor : undefined;
      let page: { nextCursor: { offset: number; revision: string; queryKey: string } | null;
        rankedCount: number; verificationLimited: boolean } | undefined;
      let v2Attempted = false;
      let v2Used = false;
      let v2Noted = false;
      const noteV2 = (unavailable: boolean) => {
        if (v2Noted) return;
        v2Noted = true;
        ctx.scope.essentiaAudit?.noteV2Joint?.(unavailable);
      };
      if (!['arousal', 'valence', 'danceability', 'voice', 'timbre', 'mood', 'instrument']
          .some(key => !!(preferences as Record<string, unknown>)[key])) {
        ctx.scope.essentiaAudit?.captureTraitResult([], 'empty');
        return ctx.emptyResult(0, 'choose at least one audio trait, or use another discovery tool');
      }
      try {
        let ids: string[] | null | undefined;
        if (ctx.scope.essentiaDiscovery && process.env.SUBWAVE_MUSIC_EVIDENCE_V2 === '1'
            && ctx.essentia?.searchJoint) {
          v2Attempted = true;
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
            // This is a technical tool deadline, not a token budget. The
            // expanded Agent has a longer per-tool guard and an on-air deadline.
            const deadline = performance.now() + (expanded ? 30_000 : 8000);
            const cohort = await ctx.eligibleEvidenceIds(deadline);
            if (cohort.status !== 'complete') {
              noteV2(true);
              ctx.scope.essentiaAudit?.captureTraitResult([], 'unavailable');
              return ctx.emptyResult(0, 'audio trait search could not finish the eligible show scope; use another discovery tool');
            }
            const queryKey = cursorKey(requested, cohort.ids);
            if (cursor && cursor.queryKey !== queryKey) return { status: 'invalid_cursor', tracks: [],
              note: 'Preferences or eligible cohort differ from this cursor; restart without it.' };
            const result = expanded
              ? await searchEligibleCohortPage(cohort.ids, requested, ctx.essentia.searchJoint,
                deadline, cursor?.offset ?? 0, 12, cursor?.revision)
              : await searchEligibleCohort(cohort.ids, requested, ctx.essentia.searchJoint, deadline);
            if (result.status !== 'complete') {
              noteV2(true);
              ctx.scope.essentiaAudit?.captureTraitResult([], 'unavailable');
              return expanded && result.reason === 'stale'
                ? { status: 'stale', tracks: [], note: 'The v3 index changed; restart without a cursor.' }
                : ctx.emptyResult(0, 'audio trait search could not finish the eligible show scope; use another discovery tool');
            }
            noteV2(false);
            v2Used = true;
            ids = result.results.map(row => row.id);
            if (expanded && 'nextOffset' in result && 'revision' in result) {
              const nextOffset = result.nextOffset;
              const revision = result.revision;
              page = { nextCursor: typeof nextOffset === 'number' && typeof revision === 'string'
                ? { offset: nextOffset, revision, queryKey } : null,
              rankedCount: result.rankedCount, verificationLimited: false };
            }
          } else {
            const queryKey = cursorKey(requested);
            if (cursor && cursor.queryKey !== queryKey) return { status: 'invalid_cursor', tracks: [],
              note: 'Preferences differ from this cursor; restart without it.' };
            const result = await ctx.essentia.searchJoint({ preferences: requested, limit: 12,
              ...(expanded ? { offset: cursor?.offset ?? 0,
                ...(cursor?.revision ? { revision: cursor.revision } : {}) } : {}) });
            if (expanded && result?.status === 'stale') return {
              status: 'stale', tracks: [], note: 'The v3 index changed; restart without a cursor.',
            };
            noteV2(!result || result.verificationLimited === true);
            v2Used = !!result && (expanded || !result.verificationLimited);
            ids = result && (expanded || !result.verificationLimited)
              ? result.results.map(row => row.id)
              : expanded ? null : await ctx.essentia.search(preferences);
            if (expanded && result?.status === 'ok') page = {
              nextCursor: result.nextOffset != null && result.revision
                ? { offset: result.nextOffset, revision: result.revision, queryKey } : null,
              rankedCount: result.rankedCount, verificationLimited: result.verificationLimited === true,
            };
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
        if (v2Used) {
          ctx.scope.essentiaAudit?.captureV2JointCandidates?.(tracks.map(track => track?.id));
        }
        ctx.scope.essentiaAudit?.captureTraitResult(
          tracks.map(track => track?.id),
          tracks.length ? 'returned' : 'empty',
        );
        if (expanded && page) return {
          status: page.verificationLimited ? 'verification_limited' : 'available',
          tracks, nextCursor: page.nextCursor, rankedCount: page.rankedCount,
          note: tracks.length ? 'Verified ranked page; continue with nextCursor if another page is useful.'
            : page.nextCursor ? 'This page had no eligible novel songs; another page remains.'
              : 'No more verified matching songs in this search.',
        };
        return tracks.length ? tracks : ctx.emptyResult(list.length, 'no available analysed tracks match; use another discovery tool');
      } catch {
        if (v2Attempted) noteV2(true);
        ctx.scope.essentiaAudit?.captureTraitResult([], 'error_or_timeout');
        return ctx.emptyResult(0, 'audio trait evidence is temporarily unavailable; use another discovery tool');
      }
    },
    });
  },
});
