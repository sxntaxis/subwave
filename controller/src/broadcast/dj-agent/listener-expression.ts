// Transient listener expression handoff. Request text remains untrusted input
// and never rides queue.json, mixer markers, durable direction state or logs
// through this module. Only the exact accepted request ID may retrieve it,
// after the corresponding track has an identity-verified mixer start.
const TTL_MS = 6 * 60 * 60_000; // queued requests can wait behind long blocks
const MAX_PENDING = 128;
const expressions = new Map<string, { text: string; at: number }>();

export function editorialListenerExpression(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const cleaned = text
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[number]')
    .replace(/\s+/g, ' ').trim().slice(0, 280);
  return cleaned || null;
}

function prune(now: number) {
  for (const [id, value] of expressions) if (now - value.at > TTL_MS) expressions.delete(id);
  while (expressions.size > MAX_PENDING) {
    const first = expressions.keys().next().value;
    if (first === undefined) break;
    expressions.delete(first);
  }
}

export function rememberListenerExpression(requestId: string, text: unknown, now = Date.now()): void {
  if (!requestId || !Number.isFinite(now)) return;
  const safe = editorialListenerExpression(text);
  if (!safe) return;
  prune(now);
  expressions.set(requestId, { text: safe, at: now });
  prune(now);
}

/** Call only after both the request attribution and the track's mixer ID pass
 * the normal queue verification guards. Retrieval is single-use. */
export function takeListenerExpression(requestId: string | null | undefined, now = Date.now()): string | null {
  if (!requestId) return null;
  prune(now);
  const value = expressions.get(requestId);
  expressions.delete(requestId);
  return value && now - value.at <= TTL_MS ? value.text : null;
}
