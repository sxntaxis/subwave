/** Keep the fixed-height player hero in view when Lyrics opens. Transcript
 * positioning and follow-scroll belong exclusively to its inner scroller. */
export interface LyricsOuterFrame {
  outerTop: number;
  outerHeight: number;
  outerScrollTop: number;
  heroTop: number;
  heroHeight: number;
}

export function lyricsOpeningScrollTop(frame: LyricsOuterFrame): number {
  const {
    outerTop, outerHeight, outerScrollTop, heroTop, heroHeight,
  } = frame;
  if (![outerTop, outerHeight, outerScrollTop, heroTop, heroHeight]
    .every(Number.isFinite) || outerHeight <= 0) return Math.max(0, outerScrollTop);

  const margin = 8;
  const heroOffset = heroTop - outerTop;
  // On a fitting player, align the top edge only if necessary; never chase a
  // lyric line by scrolling the outer player surface.
  if (heroHeight <= outerHeight - margin * 2) {
    return Math.max(0, Math.round(outerScrollTop + heroOffset - margin));
  }
  // A compact viewport may require the controls to be reached by ordinary
  // page scroll, but opening Lyrics itself must not move the outer viewport.
  return Math.max(0, Math.round(outerScrollTop + Math.min(0, heroOffset - margin)));
}
