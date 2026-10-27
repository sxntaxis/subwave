/** Presentation is not the listener's preference. A missing lyric document
 * produces an animated artwork fallback, while keeping user intent intact. */
export type LyricsViewPhase = 'artwork' | 'opening' | 'lyrics' | 'closing';
export const LYRICS_VIEW_MOTION_MS = 580;
export function requestLyricsView(phase: LyricsViewPhase, wantedNow: boolean): LyricsViewPhase {
  if (wantedNow) return phase === 'artwork' || phase === 'closing' ? 'opening' : phase;
  return phase === 'lyrics' || phase === 'opening' ? 'closing' : phase;
}
export function settleLyricsView(phase: LyricsViewPhase): LyricsViewPhase {
  return phase === 'opening' ? 'lyrics' : phase === 'closing' ? 'artwork' : phase;
}
export function lyricsSurfaceMounted(phase: LyricsViewPhase): boolean { return phase !== 'artwork'; }
