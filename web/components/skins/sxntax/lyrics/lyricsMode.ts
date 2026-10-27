import type { LyricDocument } from './lyricsModel';
import type { LyricsLoadStatus } from './useCurrentLyrics';

/** Lyrics is a presentation of the existing hero, never an empty destination. */
export function canShowLyrics(
  status: LyricsLoadStatus,
  document: LyricDocument | null,
  preview: boolean,
): boolean {
  return preview || (status === 'available' && document !== null);
}

/** Keep the current preference during a transition's loading window, but
 * return to artwork as soon as the new track is confirmed unavailable. */
export function shouldReturnToArtwork(
  open: boolean,
  preview: boolean,
  songId: string | null,
  offline: boolean,
  status: LyricsLoadStatus,
): boolean {
  return open && !preview &&
    (offline || !songId || status === 'missing' || status === 'error');
}

/** Whether a verified document may run. This is distinct from scene ownership:
 * loading/error may own a neutral lyric scene without running a document. */
export function shouldShowRequestedLyrics(
  wanted: boolean, status: LyricsLoadStatus, document: LyricDocument | null,
  preview: boolean, offline: boolean,
): boolean {
  return wanted && (preview || !offline) && canShowLyrics(status, document, preview);
}

/** Only confirmed absence (or off-air) releases the lyric scene to Artwork.
 * A loading/error recording must never revive the previous document. */
export function shouldKeepLyricsScene(
  wanted: boolean, status: LyricsLoadStatus, preview: boolean, offline: boolean,
): boolean {
  return wanted && (preview || (!offline && status !== 'missing'));
}
