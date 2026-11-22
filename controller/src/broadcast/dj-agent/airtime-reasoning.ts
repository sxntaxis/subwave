// The picker may reason while a real music slot remains available. All timing
// comes from the queue's observed clock and effective cue points, never from
// a track's original duration or a made-up future timestamp.
import { DRAIN_COMMIT_RESERVE_SEC, HARD_DEADLINE_SEC, playableDurationSec } from '../drain-policy.js';
import type { PickTarget, QueueItem } from '../queue/types.js';
import { pickTargetValid } from '../queue/pick-target.js';

export interface AirtimeQueueView {
  current: QueueItem | null;
  upcoming: QueueItem[];
  remainingSecOnAir(): number | null;
  remainingUntilItemAirs(item: QueueItem): number | null;
}

export interface AirtimeSnapshot {
  current: QueueItem | null;
  currentStartedAt: string | null;
  upcoming: readonly QueueItem[];
  target: PickTarget;
  // A commit is invalidated if the operator changes the target's show, even
  // when its predecessor happens to remain the same queue object.
  showId: string | null;
}

// This reserve is the existing hard drain deadline PLUS the existing handoff
// commit runway. Neither number was chosen to optimize token consumption.
export const AIRTIME_COMMIT_RESERVE_SEC = HARD_DEADLINE_SEC + DRAIN_COMMIT_RESERVE_SEC;
// Runtime safety only; settings currently allow agent timeouts through 300s.
export const AIRTIME_TECHNICAL_MAX_MS = 300_000;

export function captureAirtimeSnapshot(queue: AirtimeQueueView, target: PickTarget, showId: string | null): AirtimeSnapshot {
  return {
    current: queue.current,
    currentStartedAt: queue.current?.startedAt ?? null,
    upcoming: [...queue.upcoming], target, showId,
  };
}

export function airtimeSnapshotValid(
  snapshot: AirtimeSnapshot, queue: AirtimeQueueView, currentShowId: string | null,
): boolean {
  return snapshot.showId === currentShowId
    && snapshot.current === queue.current
    && snapshot.currentStartedAt === (queue.current?.startedAt ?? null)
    && snapshot.upcoming.length === queue.upcoming.length
    && snapshot.upcoming.every((item, i) => item === queue.upcoming[i])
    && pickTargetValid(snapshot.target, queue.current, queue.upcoming);
}

/**
 * Null means there is no trustworthy air clock: retain the legacy timeout.
 * Zero means there is no safe exploration runway: use the existing Pool path.
 * This value is RECOMPUTED after asynchronous preparation, immediately before
 * the Agent call, so that time spent loading the show cannot be spent twice.
 */
export function airtimePickerTimeoutMs(queue: AirtimeQueueView, target: PickTarget): number | null {
  if (!pickTargetValid(target, queue.current, queue.upcoming)) return 0;
  let runway = target.kind === 'current'
    ? queue.remainingSecOnAir()
    : queue.remainingUntilItemAirs(target.item);
  if (runway == null || !Number.isFinite(runway)) return null;
  if (target.kind !== 'current') {
    const track = target.item.track;
    const duration = typeof track?.duration === 'number' ? track.duration : Number(track?.duration);
    const span = playableDurationSec(duration, target.item.cueOutSec ?? null, target.item.cueInSec ?? null);
    if (span == null) return null;
    runway += span;
  }
  if (runway <= AIRTIME_COMMIT_RESERVE_SEC) return 0;
  return Math.max(0, Math.min(AIRTIME_TECHNICAL_MAX_MS,
    Math.floor((runway - AIRTIME_COMMIT_RESERVE_SEC) * 1000)));
}
