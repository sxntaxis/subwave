/** Progress stops at the listener-time pause boundary, even in a freshly opened tab. */
export function playbackElapsedSeconds(startedAt: number | null, pausedAt: number | null, now: number): number {
  if (startedAt == null) return 0;
  return Math.max(0, Math.floor((Math.min(now, pausedAt ?? Infinity) - startedAt) / 1000));
}
