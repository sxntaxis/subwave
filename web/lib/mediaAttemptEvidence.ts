export function mediaEventBelongsToAttempt(expectedSource: string | null, eventSource: string): boolean {
  return expectedSource !== null && expectedSource !== '' && eventSource === expectedSource;
}

export function mediaClockAdvancedForAttempt({
  expectedSource,
  eventSource,
  currentTime,
  baseline,
}: {
  expectedSource: string | null;
  eventSource: string;
  currentTime: number;
  baseline: number;
}): boolean {
  return mediaEventBelongsToAttempt(expectedSource, eventSource) &&
    Number.isFinite(currentTime) && Number.isFinite(baseline) && currentTime > baseline;
}

export function isCurrentPlayGeneration(playGeneration: number, currentGeneration: number): boolean {
  return playGeneration === currentGeneration;
}
