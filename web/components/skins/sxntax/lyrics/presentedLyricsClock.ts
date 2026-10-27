/** Keep the outgoing lyric document on its own monotonic timeline while the
 * next song is already feeding the live station clock. The title/renderer
 * handoff owns when the incoming timeline becomes authoritative. */
export type PresentedLyricsSnapshot = Readonly<{ key: string; ms: number | null }>;
export function presentedLyricPosition(
  presentedKey: string, airingKey: string, liveMs: number | null, previous: PresentedLyricsSnapshot,
): number | null {
  return presentedKey === airingKey ? liveMs : previous.key === presentedKey ? previous.ms : null;
}
