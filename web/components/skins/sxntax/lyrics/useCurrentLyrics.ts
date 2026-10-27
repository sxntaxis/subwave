'use client';

import { useEffect, useState } from 'react';
import type { StationClient } from '@/lib/stationClient';
import { validLyricDocument, type LyricDocument } from './lyricsModel';

export type LyricsLoadStatus = 'loading' | 'available' | 'missing' | 'error';

interface LyricsLoad {
  songId: string | null;
  status: LyricsLoadStatus;
  document: LyricDocument | null;
}

/** Fetches only the selected live song, aborting stale requests on transition.
 * The `songId` guard also prevents an old document appearing for one render
 * between a prop change and the next effect's cleanup.
 */
export function useCurrentLyrics(
  client: StationClient, songId: string | null, enabled: boolean, refreshKey = false,
): { status: LyricsLoadStatus; document: LyricDocument | null } {
  const [loaded, setLoaded] = useState<LyricsLoad>({ songId: null, status: 'missing', document: null });
  useEffect(() => {
    if (!enabled || !songId) return;
    const controller = new AbortController();
    // An unresolved provider owns a bounded neutral state, not old words.
    const timeout = window.setTimeout(() => {
      controller.abort();
      setLoaded({ songId, status: 'error', document: null });
    }, 15000);
    // Revalidate after the listener tunes in (and may acquire station auth),
    // without blanking an already-valid document for this same recording.
    setLoaded(previous => previous.songId === songId && previous.status === 'available'
      ? previous : { songId, status: 'loading', document: null });
    client.currentLyrics(songId, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        window.clearTimeout(timeout);
        const doc = result.document && validLyricDocument(result.document) ? result.document : null;
        setLoaded({ songId, status: doc ? 'available' : 'missing', document: doc });
      })
      .catch(() => {
        window.clearTimeout(timeout);
        if (!controller.signal.aborted) setLoaded({ songId, status: 'error', document: null });
      });
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [client, enabled, songId, refreshKey]);
  if (!enabled || !songId) return { status: 'missing', document: null };
  if (loaded.songId !== songId) return { status: 'loading', document: null };
  return { status: loaded.status, document: loaded.document };
}
