import type { NowPlaying } from './types.js';

/** Never pass private mixer attribution metadata to a consumer of now-playing. */
export function publicNowPlaying(np: NowPlaying | null): NowPlaying | null {
  if (!np) return null;
  const copy = { ...np };
  delete copy.subwave_queue_token;
  delete copy.subwave_clip;
  return copy;
}
