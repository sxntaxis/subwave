// Interpret a listener's lyrical intent independently of acoustic style. The
// request DJ proposes semantic expansions in its normal first run; code handles
// retrieval and requires grounded evaluation before queue admission.
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
  // An explicit cue preserves the need for evidence if a provider fails or
  // misclassifies. It does NOT provide a subject-specific synonym dictionary.
  if (!explicit && (!meaning || meaning.kind === 'chat' || meaning.lyrical_mode === 'none')) return null;
  const mode = explicit ? 'required' : meaning?.lyrical_mode;
  if (mode !== 'required' && mode !== 'supporting') return null;
  // An explicit cue requires lyrical grounding, but the model may refine the
  // subject (e.g. cars -> driving, vehicle culture). Use the literal theme as
  // the fallback when the model cannot supply a meaningful interpretation.
  const hasModelMeaning = meaning?.lyrical_mode === 'required' || meaning?.lyrical_mode === 'supporting';
  const topic = clean(hasModelMeaning ? meaning?.lyrical_subject : null, 120)
    || clean(explicit, 120);
  if (topic.length < 3) return null;
  // The model may propose linguistic paraphrases or indirect concepts. Treat
  // them as recall hints, NEVER as proof that the requested meaning is present.
  const rawConcepts = (hasModelMeaning ? meaning?.lyrical_concepts ?? [] : [])
    .filter((s): s is string => typeof s === 'string');
  // Preserve the exact listener subject as one recall term when the model
  // reframes it. It is not a privileged vocabulary expansion.
  if (explicit && topic.toLocaleLowerCase('und') !== explicit.toLocaleLowerCase('und')) {
    rawConcepts.unshift(explicit);
  }
  const concepts = [...new Set(rawConcepts
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

/** A query plan is not lyrical evidence. A model-declared lyrical request
 * always requires a controller-run lyric search and a grounded evaluation. */
export function lyricHydrationNeeded(intent: LyricIntent | null): boolean {
  return !!intent;
}

/** Bounded merge of independently proposed retrieval concepts, never an
 * endorsement of their semantic correctness. Used for one optional expansion. */
export function mergeLyricConcepts(
  initial: LyricIntent, suggested: LyricIntent | null,
): LyricIntent {
  if (!suggested) return initial;
  const seen = new Set(initial.concepts);
  const additions = suggested.concepts.filter(c => !seen.has(c));
  // A full first-pass list must not prevent a genuine revised query. Give up
  // to three new concepts room, while retaining the strongest earlier ones.
  const space = Math.min(3, additions.length);
  const concepts = [...initial.concepts.slice(0, 6 - space), ...additions.slice(0, space)];
  return { ...initial, mode: initial.mode === 'required' || suggested.mode === 'required' ? 'required' : 'supporting',
    concepts };
}
