/** Bounded, deterministic subject matching for already-stored lyrics.
 * A word in metadata, genre, or sound analysis is never proof of lyrical theme.
 * These signals are *evidence for the request agent to judge*, not a claim of
 * authorial meaning. No lyric text is persisted or emitted to public APIs. */

export type LyricThemeTerm = { text: string; weight: number };
export type LyricThemeEvidence = {
  strength: 'repeated_context' | 'specific_mention' | 'incidental_mention' | 'semantic_hypothesis';
  matchedTerms: string[];
  distinctLines: number;
  occurrences: number;
  // Short, noncontiguous evidence windows for the existing private request agent.
  windows: string[];
  lexicalScore: number;
};

function fold(s: string): string {
  return s.normalize('NFKC').toLocaleLowerCase('und').replace(/[\u0300-\u036f]/g, '');
}

/** Deterministic fallback for obvious lyrical cues when classification fails.
 * General lyrical intent is resolved by the existing LLM request librarian. */
export function explicitLyricTheme(text: string): string | null {
  const s = text.trim().slice(0, 320);
  const patterns = [
    /^(?:(?:please|could you|can you|i(?:'d| would) like(?: to hear)?|play|find|put on|give me)\s+)*(?:(?:me|us|some|any|a few)\s+)*(?:songs?|tracks?|music|tunes?)\s+(?:about|concerning|related to|dealing with|whose lyrics? (?:are|is) about|with lyrics? about)\s+(.+)$/i,
    /^(.+?)[\s-]+related\s+(?:songs?|tracks?|music|tunes?)$/i,
    /^(?:(?:pon|busca|quiero|dame)\s+)*(?:(?:unas?|algunas?)\s+)?(?:canciones?|temas?|m[uú]sica)\s+(?:sobre|acerca de|relacionad[ao]s? con|que hablen de)\s+(.+)$/i,
    /^(?:songs?|tracks?)\s+(?:with|containing)\s+lyrics?\s+(?:about|on)\s+(.+)$/i,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m?.[1]) {
      const theme = m[1].replace(/[.?!,\s]+$/g, '').trim();
      if (theme.length >= 3 && theme.length <= 120) return theme;
    }
  }
  return null;
}

const STOP = new Set(['the','and','with','from','that','this','about','songs','song','music','tracks','related','what','where','when','some','canciones','sobre','de','del','las','los','una','unos','que','con','para','are','how','feel','feeling','something','things','life','a','an','to','of','in','is','my','me','you','your','and']);

/** Search vocabulary is generic: the request DJ supplies expansions for ANY
 * subject. Never give one subject a hard-coded thesaurus or promote synonyms
 * into evidence without reading actual stored lyrics. */
export function lyricThemeTerms(theme: string, concepts: readonly string[] = []): LyricThemeTerm[] {
  const normalized = fold(theme);
  const terms = new Map<string, number>();
  const add = (term: string, weight: number) => {
    if (term.length > 2 && !STOP.has(term)) terms.set(term, Math.max(terms.get(term) ?? 0, weight));
  };
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) add(token, token.length >= 5 ? 1 : 0.8);
  if (tokens.length > 1 && tokens.length <= 5) add(tokens.join(' '), 1.8);
  // LLM-derived concepts broaden recall for every topic. A suggestion can be wrong; its
  // presence does not make a track eligible without real lyrics to interpret.
  for (const concept of concepts.slice(0, 6)) {
    if (typeof concept !== 'string') continue;
    const words = fold(concept).match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const word of words) add(word, 0.95);
    if (words.length > 1 && words.length <= 4) add(words.join(' '), 1.25);
  }
  return [...terms.entries()].map(([text, weight]) => ({ text, weight }))
    .sort((a, b) => b.weight - a.weight || b.text.length - a.text.length)
    .slice(0, 24);
}

function occurrencesIn(line: string, term: string): number {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Escape literal regex punctuation and exclude substring hits (e.g. "car"
  // inside "scar"). Use Unicode-aware boundaries, not ASCII \b.
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu');
  return [...line.matchAll(re)].length;
}

export function lyricThemeEvidence(lyrics: string, terms: readonly LyricThemeTerm[]): LyricThemeEvidence | null {
  if (!lyrics || lyrics.trim().length < 24 || !terms.length) return null;
  const lines = lyrics.split(/\r?\n|(?<=[.!?])\s+/).filter(Boolean);
  const matched = new Map<string, number>();
  const hits: Array<{ index: number; line: string; score: number }> = [];
  let occurrences = 0;
  for (let i = 0; i < lines.length; i++) {
    const folded = fold(lines[i]);
    let score = 0;
    for (const { text, weight } of terms) {
      const count = occurrencesIn(folded, text);
      if (!count) continue;
      matched.set(text, (matched.get(text) ?? 0) + count);
      score += Math.min(count, 3) * weight;
      occurrences += count;
    }
    if (score > 0) hits.push({ index: i, line: lines[i], score });
  }
  if (!hits.length) return null;
  // Repeating the same chorus is evidence of topical salience, but should not
  // impersonate diverse, independently verified contexts.
  const distinctLines = new Set(hits.map(h => fold(h.line).replace(/\s+/g, ' ').trim())).size;
  const specific = [...matched.keys()].some(term => (terms.find(t => t.text === term)?.weight ?? 0) >= 1.3);
  const strength = distinctLines >= 2 && (occurrences >= 2 || matched.size > 1)
    ? 'repeated_context' : specific ? 'specific_mention' : 'incidental_mention';
  const windows: string[] = [];
  for (const hit of [...hits].sort((a,b) => b.score - a.score || a.index - b.index)) {
    // Keep the neighbouring lyric context for negation, speaker perspective,
    // and metaphor; a single matching line often means the opposite of what
    // the keyword suggests. At most three short excerpts, never full lyrics.
    const current = hit.line.trim().replace(/\s+/g, ' ');
    const firstTerm = terms.map(t => fold(current).indexOf(t.text)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const focus = current.length > 190
      ? current.slice(Math.max(0, firstTerm - 65), firstTerm + 155)
      : current;
    const context = [lines[hit.index - 1], focus, lines[hit.index + 1]]
      .filter(Boolean).map(line => line.trim().replace(/\s+/g, ' '));
    const window = context.join(' / ').slice(0, 240);
    if (window && !windows.some(s => fold(s) === fold(window))) windows.push(window);
    if (windows.length === 3) break;
  }
  const lexicalScore = Math.min(15, hits.reduce((acc, h) => acc + Math.min(3, h.score), 0))
    + Math.min(6, distinctLines) + Math.min(3, matched.size) * 1.5;
  return { strength, matchedTerms: [...matched.keys()], distinctLines, occurrences, windows, lexicalScore };
}

/** A semantic hit is an unverified hypothesis: expose short passages from
 * separate parts of stored lyrics so the existing LLM can reason about the
 * words themselves. Never pass metadata or a vector score as lyrical proof.
 * No new persisted representation; no full lyrics in the tool transcript. */
export function semanticLyricHypothesis(lyrics: string): LyricThemeEvidence | null {
  if (typeof lyrics !== 'string' || lyrics.trim().length < 50) return null;
  const lines = lyrics.split(/\r?\n|(?<=[.!?])\s+/).map(s => s.trim().replace(/\s+/g, ' '))
    .filter(s => s.length >= 12);
  const unique = [...new Set(lines.map(s => s.slice(0, 200)))];
  if (!unique.length) return null;
  // Sample across the complete lyrics, not just their opening. Hypothesis only:
  // a few windows may miss metaphors; don't pretend coverage is complete.
  const points = [0, Math.floor((unique.length - 1) / 3), Math.floor(2 * (unique.length - 1) / 3), unique.length - 1];
  const windows = [...new Set(points.map(i => unique[i]))].slice(0, 4);
  return {
    strength: 'semantic_hypothesis', matchedTerms: [], distinctLines: 0,
    occurrences: 0, windows, lexicalScore: 0,
  };
}
