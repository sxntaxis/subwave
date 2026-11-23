/** Private lyrical evidence is for an in-flight model decision, never for the
 * persistent LLM audit transcript or a request-visible response. */
export function redactPrivateLyricSlate(value: string): string {
  return value.replace(/\[PRIVATE_LYRICS_START\][\s\S]*?\[PRIVATE_LYRICS_END\]/g,
    '[PRIVATE LYRICAL EVIDENCE REDACTED]');
}


/** The request tool loop also returns lyric windows from searchByLyrics.
 * Preserve IDs and scores for audit but never persist actual passages through
 * the discovery trail, session meta or terminal-fallback diagnostics. */
export function redactLyricToolResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLyricToolResult);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = key === 'windows' || key === 'lyric_excerpt' || key === 'lyrics'
      ? '[PRIVATE LYRICAL EVIDENCE REDACTED]' : redactLyricToolResult(item);
  }
  return out;
}
