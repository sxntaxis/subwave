import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import * as blocklist from '../../../../../music/blocklist.js';
import { explicitLyricTheme } from '../../../../../music/lyrics-theme-core.js';
import { searchLyricsTheme } from '../../../../../music/lyrics-theme-search.js';
import { definePickerTool } from '../defs.js';

// Lexical proof is the baseline. The existing text embeddings are optional
// recall, not the authority over what the lyrics say. No new index or model.
export default definePickerTool({
  name: 'searchByLyrics',
  build: ({ scope, collect, emptyResult }) => tool({
    description: 'LYRICAL SUBJECT search. Finds tracks with words actually present in stored lyrics, not tracks whose genre or acoustic mood sounds associated with the topic. Evidence distinguishes repeated context from a single mention; assess whether the snippets genuinely support the listener\'s topic. On an explicit listener subject request this is the only discovery tool. No lyrics means unknown, not a positive thematic match.',
    inputSchema: z.object({ query: z.string().min(3).describe('Subject of the lyrics, e.g. cannabis, leaving home, loneliness') }),
    execute: async ({ query }) => {
      try {
        const hits = scope.lyricTheme
          ? scope.lyricTheme.candidates
          : await searchLyricsTheme(explicitLyricTheme(query) ?? query, 32);
        const candidates = blocklist.rejectBlocked(hits.map(h => library.slimById(h.id)).filter(Boolean));
        // Unlike general similarity discovery, a theme ranking must survive
        // the shared candidate cap: freshness shuffling would discard the
        // strongest lyric evidence before the model saw it.
        const offered = collect(candidates, 12, { preserveRank: true });
        const evidenceById = new Map(hits.map(h => [h.id, h.evidence] as const));
        const out = offered.map(track => ({ ...track, lyricalEvidence: evidenceById.get(track.id) }));
        return out.length ? out : emptyResult(hits.length,
          'No eligible track has corroborating stored-lyrics evidence for this subject. Do not substitute genre, mood or artist stereotypes.');
      } catch (err) { return { error: `lyric evidence retrieval unavailable: ${(err as Error).message}` }; }
    },
  }),
});
