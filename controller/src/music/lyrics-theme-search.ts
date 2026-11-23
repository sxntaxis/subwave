// Hybrid retrieval of lyrical *subject*, not acoustic/genre similarity.
// The preexisting text index remains unchanged. Semantic hits are hypotheses
// with bounded lyric passages, never automatically proven lyrical matches.
import * as library from './library.js';
import * as libraryDb from './library-db.js';
import * as embeddings from './embeddings.js';
import { lyricThemeEvidence, lyricThemeTerms, semanticLyricHypothesis, type LyricThemeEvidence } from './lyrics-theme-core.js';

export interface LyricThemeCandidate { id: string; evidence: LyricThemeEvidence; rank: number; }

export async function searchLyricsTheme(theme: string, limit = 24, concepts: readonly string[] = []): Promise<LyricThemeCandidate[]> {
  const topic = theme.trim().slice(0, 120);
  const terms = lyricThemeTerms(topic, concepts);
  if (!terms.length) return [];
  await library.load();
  const lexical = libraryDb.searchStoredLyrics(terms.map(t => t.text));
  const lexicalIds = new Set(lexical.map(r => r.id));
  let semantic: Array<{ id: string }> = [];
  // The legacy text vectors mix metadata + short lyric leads. They can expand
  // recall but cannot by themselves assert lyrical meaning.
  try {
    if (embeddings.isAvailable() && (library.stats().withEmbedding ?? 0) > 0) {
      // This is a listener request on the live controller, not a batch job.
      // Bound the optional provider wait; lexical results must still work when
      // the embedding transport is slow or absent.
      // Use the DJ's proposed semantic vocabulary for vector recall too, not
      // just the literal subject. This is still the existing mixed text index:
      // vector similarity suggests candidates, never establishes lyric meaning.
      const semanticQuery = `Songs whose lyrics concern ${topic}. Related expressions: ${concepts.slice(0, 6).join(', ')}`.slice(0, 540);
      const vec = await Promise.race([
        embeddings.embedQueryText(semanticQuery, library.embeddingIndexTextMode()),
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
    const checked = evidence ?? (semanticRank.has(row.id) ? semanticLyricHypothesis(row.lyric_excerpt) : null);
    if (!checked) continue;
    const semanticPosition = semanticRank.get(row.id);
    // Rank-level fusion is deliberately a small *bonus*: metadata-only
    // vector similarity never becomes proof of lyrical relevance.
    const semanticBonus = semanticPosition ? 20 / (60 + semanticPosition) : 0;
    const rank = checked.lexicalScore + semanticBonus;
    scored.push({ id: row.id, evidence: checked, rank });
  }
  // Reserve a few slots for semantic hypotheses even when many literal hits
  // exist; otherwise figurative songs disappear behind the lexical candidate cap.
  const sort = (a: LyricThemeCandidate, b: LyricThemeCandidate) => b.rank - a.rank || a.id.localeCompare(b.id);
  const literal = scored.filter(s => s.evidence.strength !== 'semantic_hypothesis').sort(sort);
  const indirect = scored.filter(s => s.evidence.strength === 'semantic_hypothesis').sort(sort);
  const cap = Math.min(Math.max(1, limit), 32);
  const semanticReserve = Math.min(indirect.length, cap >= 8 ? 4 : 1);
  return [...literal.slice(0, cap - semanticReserve), ...indirect.slice(0, semanticReserve)]
    .sort(sort).slice(0, cap);
}
