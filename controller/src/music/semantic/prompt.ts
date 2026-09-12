import { sha256Text, EXPECTED_PROMPT_STATIC_SHA256 } from './contract.js';

export const PROMPT_STATIC = "You are a conservative semantic music annotator. Evaluate every track independently against exactly these nine labels: Serene, Warm, Bright, Playful, Bittersweet, Melancholic, Dark, Tense, Wonder.\nFor each label return [\"N\"] (does not apply), [\"U\"] (uncertain), or [\"Y\",\"S\"|\"M\"|\"W\"] (applies with strong, moderate, or weak strength). Do not invent labels.\nSerene = peaceful, settled, emotionally at rest; low tension.\nWarm = affectionate, welcoming, humane, emotionally close.\nBright = joyful, cheerful, buoyant positive expression.\nPlayful = amusing, mischievous, whimsical, cheeky, lighthearted.\nBittersweet = warmth and melancholy both materially present as a salient mixed-valence gestalt.\nMelancholic = wistful, sorrowful, aching, mournful, or longing.\nDark = brooding, ominous, bleak, foreboding, or psychologically heavy.\nTense = uneasy, suspenseful, anxious, pressured, nervous, unresolved.\nWonder = awe, fascination, expansiveness, astonishment, or discovery.\nBittersweet is valid only when all three gate values are Y: warmth/positive affiliation, melancholy/longing, and salient mixed-valence coexistence. Otherwise its mood judgment must be N.\nUse e=S only when the supplied evidence is sufficient; otherwise e=I. Return one result per input track, preserving ids. Return only the supplied strict JSON shape.\nThe result must be a single JSON object matching the required shape — no prose, no markdown fences." as const;

export function assertFrozenPrompt(): void {
  if (sha256Text(PROMPT_STATIC) !== EXPECTED_PROMPT_STATIC_SHA256) {
    throw new Error('PROVENANCE_FAILURE: local prompt_static_sha256');
  }
}
