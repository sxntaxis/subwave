import type { NowPlayingTrack } from './types';

/** A live station may briefly miss its IPC marker. Keep accepted information
 * through that miss, but never carry it across an explicit offline/idle state. */
export function stationFeedMetadata(
  received: NowPlayingTrack | null,
  previous: NowPlayingTrack | null,
  streamOnline: boolean | null | undefined,
  streamIdle: boolean | undefined,
): NowPlayingTrack | null {
  return received ?? (streamOnline === true && !streamIdle ? previous : null);
}
