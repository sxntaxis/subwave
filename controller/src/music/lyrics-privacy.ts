/** Private lyrical evidence is for an in-flight model decision, never for the
 * persistent LLM audit transcript or a request-visible response. */
export function redactPrivateLyricSlate(value: string): string {
  return value.replace(/\[PRIVATE_LYRICS_START\][\s\S]*?\[PRIVATE_LYRICS_END\]/g,
    '[PRIVATE LYRICAL EVIDENCE REDACTED]');
}
