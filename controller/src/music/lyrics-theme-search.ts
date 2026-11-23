// Hybrid retrieval of lyrical *subject*, not acoustic/genre similarity.
// The preexisting text index remains unchanged; semantic hits never count as
// lyrical proof without corroborating words in the stored lyrics themselves.
import * as library from './library.js';
import * as libraryDb from './library-db.js';
import * as embeddings from './embeddings.js';
import { lyricThemeEvidence, lyricThemeTerms, type LyricThemeEvidence } from './lyrics-theme-core.js';

export interface LyricThemeCandidate { id: string; evidence: LyricThemeEvidence; rank: number; }

export async function searchLyricsTheme(theme: string, limit = 24): Promise<LyricThemeCandidate[]> {
  const topic = theme.trim().slice(0, 120);
  const terms = lyricThemeTerms(topic);
  if (!terms.length) return [];
  await library.load();
  const lexical = libraryDb.searchStoredLyrics(terms.map(t => t.text));
  const lexicalIds = new Set(lexical.map(r => r.id));
  let semantic: Array<{ id: string }> = [];
  // The legacy text vectors mix metadata + short lyric leads. They can expand
  // recall but cannot by themselves assert lyrical meaning.
  try {
    if (lexical.length < 30 && embeddings.isAvailable() && (library.stats().withEmbedding ?? 0) > 0) {
      // This is a listener request on the live controller, not a batch job.
      // Bound the optional provider wait; lexical results must still work when
      // the embedding transport is slow or absent.
      const vec = await Promise.race([
        embeddings.embedQueryText(`songs about ${topic}`, library.embeddingIndexTextMode()),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 2500)),
      ]);
      if (vec) {
        const rows = await Promise.race([
          library.tracksByVectorAsync(vec, 60),
          new Promise<any[]>(resolve => setTimeout(() => resolve([]), 1500)),
        ]);
        semantic = rows.filter((s: any) => typeof s?.id === 'string')
          .map((s: any) => ({ id: s.id }));
      }
    }
  } catch { /* lexical evidence remains useful without a provider */ }
  const extraRows = libraryDb.readStoredLyrics(semantic.map(s => s.id).filter(id => !lexicalIds.has(id)));
  const semanticRank = new Map<string, number>(semantic.map((s, i) => [s.id, i + 1] as const));
  const scored: LyricThemeCandidate[] = [];
  for (const row of [...lexical, ...extraRows]) {
    const evidence = lyricThemeEvidence(row.lyric_excerpt, terms);
    if (!evidence || evidence.strength === 'incidental_mention') continue;
    const semanticPosition = semanticRank.get(row.id);
    // Rank-level fusion is deliberately a small *bonus*: metadata-only
    // vector similarity cannot outweigh an actual lyrical reference.
    const semanticBonus = semanticPosition ? 20 / (60 + semanticPosition) : 0;
    const rank = evidence.lexicalScore + semanticBonus;
    scored.push({ id: row.id, evidence, rank });
  }
  scored.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  return scored.slice(0, Math.min(Math.max(1, limit), 32));
}
