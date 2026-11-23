// Interpret a listener's intended *lyrical meaning* separately from acoustic
// style, genre, a named track, and mood. This is resolved before DJ discovery:
// the request agent must not decide whether to call a lyric tool.
import { explicitLyricTheme } from './lyrics-theme-core.js';

export type LyricIntentMode = 'required' | 'supporting';
export interface LyricIntent {
  topic: string;
  mode: LyricIntentMode;
  concepts: string[];
}

export interface RequestMeaning {
  kind?: 'track' | 'chat';
  lyrical_mode?: 'required' | 'supporting' | 'none' | null;
  lyrical_subject?: string | null;
  lyrical_concepts?: string[] | null;
}

const clean = (s: unknown, max: number): string => typeof s === 'string'
  ? s.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  : '';

export function resolveLyricIntent(text: string, meaning?: RequestMeaning | null): LyricIntent | null {
  const explicit = explicitLyricTheme(text);
  // A deterministic explicit cue survives provider unavailability or an LLM
  // misclassifying the topic as merely a musical mood.
  if (!explicit && (!meaning || meaning.kind === 'chat' || meaning.lyrical_mode === 'none')) return null;
  const mode = explicit ? 'required' : meaning?.lyrical_mode;
  if (mode !== 'required' && mode !== 'supporting') return null;
  const topic = clean(explicit ?? meaning?.lyrical_subject, 120);
  if (topic.length < 3) return null;
  // The model may propose linguistic paraphrases or indirect concepts. Treat
  // them as recall hints, NEVER as proof that the requested meaning is present.
  const concepts = [...new Set((meaning?.lyrical_concepts ?? [])
    .filter((s): s is string => typeof s === 'string')
    .map(s => clean(s, 42).toLocaleLowerCase('und'))
    .filter(s => s.length >= 3 && !/[\n{}<>]/.test(s)))].slice(0, 6);
  return { topic, mode, concepts };
}

/** Cheap *suspicion* only, not a semantic verdict. If the request agent says
 * "no lyrical meaning" despite these cues, ask the existing librarian to
 * resolve the disagreement before a candidate is admitted to the queue.
 * No extra call for ordinary genre, artist, or mood requests. */
export function needsLyricalMeaningReview(text: string): boolean {
  const s = text.slice(0, 360).toLocaleLowerCase('und');
  return /\b(?:lyrics?|lyrical|words (?:say|mean)|song\s*stories|storytelling|narratives?|stories (?:of|about)|sings? about|talks? about|speaks? (?:of|about)|messages? about|themes? (?:of|about)|canciones? que (?:hablen|cuenten)|letras? (?:sobre|de|que)|historias? (?:de|sobre))\b/u.test(s);
}


/** Admission is an ID + actual-lyric-evidence-bound model verdict, never a
 * free-floating natural-language claim. This deliberately cannot evaluate the
 * truth of metaphors; it only ensures interpretation follows retrieval. */
export function groundedLyricChoice(pick: unknown, ids: { has(id: string): boolean }): boolean {
  const p = pick as { id?: unknown; lyrical_basis?: unknown; lyrical_reading?: unknown } | null;
  return !!(p && typeof p.id === 'string' && ids.has(p.id)
    && (p.lyrical_basis === 'central' || p.lyrical_basis === 'contextual')
    && typeof p.lyrical_reading === 'string' && p.lyrical_reading.trim().length >= 12);
}

/** A grounded pass is guaranteed for newly inferred meaning; a second search
 * on the existing slate needs genuinely new LLM-suggested concepts. */
export function lyricHydrationNeeded(
  preloaded: LyricIntent | null, inferred: LyricIntent | null, initialGrounded: boolean,
): boolean {
  const resolved = preloaded ?? inferred;
  if (!resolved) return false;
  if (!preloaded) return true;
  return resolved.mode === 'required' && !initialGrounded
    && !!inferred?.concepts.some(c => !preloaded.concepts.includes(c));
}
