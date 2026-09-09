import type { PickTarget, QueueItem } from './types.js';

export function pickTargetValid(
  target: PickTarget,
  current: QueueItem | null,
  upcoming: QueueItem[],
): boolean {
  if (target.kind === 'current') return current === target.item && upcoming.length === 0;
  return upcoming[upcoming.length - 1] === target.item;
}
