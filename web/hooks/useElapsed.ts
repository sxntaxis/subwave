'use client';

import { useEffect, useState } from 'react';
import { pollWhileVisible } from '@/lib/poll';
import { playbackElapsedSeconds } from '@/lib/playbackTime';
import type { StationClock } from '@/lib/stationClock';

// Playback seconds since the effective `startedAt`, capped at `pausedAt` during
// station standby, 0 when null. The interval pauses while the tab is
// hidden and recomputes on return, so the readout never drifts. Call this in the
// leaf component that displays the time: keeping the 1s tick out of
// useStationFeed is what stops it re-rendering the whole player.
export function useElapsed(startedAt: number | null, pausedAt: number | null = null, stationClock?: StationClock): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (startedAt == null) {
      setElapsed(0);
      return;
    }
    return pollWhileVisible(
      () => {
        const now = stationClock ? stationClock.nowMs() : Date.now();
        if (now !== null) setElapsed(playbackElapsedSeconds(startedAt, pausedAt, now));
      },
      1000,
    );
  }, [startedAt, pausedAt, stationClock]);
  return elapsed;
}
