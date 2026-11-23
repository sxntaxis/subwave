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
