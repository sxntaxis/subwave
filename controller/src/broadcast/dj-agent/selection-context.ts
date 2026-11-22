import type { PickTarget, QueueItem } from '../queue/types.js';

// A forecast is useful only when the actual immediate predecessor and show are
// provable. Unknown, malformed, requested or boundary-crossing cases retain
// the historical baseline. Upcoming items are never novelty history.
export function selectionContext(
  target: PickTarget,
  current: QueueItem | null,
  upcoming: QueueItem[],
  history: QueueItem[],
  showAt: Date | null,
  showId: string | null,
  showAtTime: (at: Date) => string | null,
  historyLimit = 5,
): { predecessorId: string; recentAiredIds: string[] } | undefined {
  try {
    if (!showId || !showAt || !Number.isFinite(showAt.getTime()) || !target?.item?.track?.id
      || target.item.requestedBy || !current?.startedAt || current.requestedBy) return;
    if (target.kind === 'current' ? current !== target.item || upcoming.length !== 0
      : upcoming[upcoming.length - 1] !== target.item) return;
    const start = new Date(current.startedAt);
    if (!Number.isFinite(start.getTime()) || showAtTime(start) !== showId
      || showAtTime(new Date()) !== showId || showAtTime(showAt) !== showId) return;
    const recentAiredIds = [current, ...history].filter(item => {
      if (!item.track?.id || item.requestedBy || !item.startedAt) return false;
      const at = new Date(item.startedAt);
      return Number.isFinite(at.getTime()) && showAtTime(at) === showId;
    }).slice(0, Math.max(1, Math.min(12, historyLimit))).map(item => item.track.id).filter((id): id is string => !!id);
    return { predecessorId: target.item.track.id, recentAiredIds };
  } catch {
    return undefined;
  }
}
