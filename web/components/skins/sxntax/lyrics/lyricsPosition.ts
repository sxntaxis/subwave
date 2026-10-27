/** Refuse implausible station-clock offsets instead of highlighting the end
 * of a six-minute song when the received start time is hours out of date. */
export function safeLyricsPositionMs(elapsedSeconds: number, durationSeconds: number | null): number | null {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) return null;
  if (durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > 0 &&
      elapsedSeconds > durationSeconds + 30) return null;
  return elapsedSeconds * 1000;
}
