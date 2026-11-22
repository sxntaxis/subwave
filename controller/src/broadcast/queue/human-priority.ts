// MI v2.3: deterministic priority arbitration for *unstarted* music. The mixer
// owns the real seam; this pure policy must never claim a latched request moved.
import type { QueueItem } from './types.js';

export interface ListenerReservation {
  id: string;
  sequence: number;
  createdAt: number;
  status: 'pending' | 'queued';
}
export type PriorityLane = 'operator' | 'listener' | null;

export function choosePendingMusic(
  upcoming: readonly QueueItem[], reservations: readonly ListenerReservation[],
  hasLockedBlock: boolean,
): QueueItem | null {
  const unsent = upcoming.filter(item => !item.sent);
  const owner = unsent.find(item => item.priorityLane === 'operator');
  if (owner) return owner;

  // A locked album already in progress or committed as ordinary FIFO must
  // finish first. New autonomous material cannot jump in front of people.
  const locked = unsent.find(item => item.block?.locked);
  if (locked) return locked;
  if (hasLockedBlock) return null; // last locked member has not yet started

  const firstHuman = reservations.find(r => r.status === 'pending' || r.status === 'queued');
  if (firstHuman) {
    // Resolution-order is not arrival-order. Never hand over later listener B
    // while earlier A still resolves, even if B's track is already queued.
    if (firstHuman.status === 'pending') return null;
    const item = unsent.find(i => i.humanRequestId === firstHuman.id);
    if (item) return item;
    // A handed-over listener request remains the head until on-air confirms
    // it; do not let a second source break physical FIFO ordering.
    return null;
  }
  return unsent[0] ?? null;
}

/** A new reservation fences in-flight AI picks, not on-air music. */
export function newReservation(id: string, sequence: number, at = Date.now()): ListenerReservation {
  return { id, sequence, createdAt: at, status: 'pending' };
}

export function futureReservationReady(reservations: readonly ListenerReservation[], id: string) {
  const index = reservations.findIndex(r => r.id === id);
  return index >= 0 && reservations.slice(0, index).every(r => r.status !== 'pending');
}

/** Human editorial authority requires evidence from the exact queued music URI.
 * Track ID/title matching remains useful for queue recovery, but cannot prove
 * that a listener/operator copy (rather than auto or an older AI copy) aired.
 */
export function verifiedHumanStart(
  item: Pick<QueueItem, 'humanRequestId' | 'operator' | 'queueToken'> | null,
  airedToken: string | null | undefined,
): 'listener' | 'admin' | 'auto' {
  if (!item?.queueToken || typeof airedToken !== 'string' || item.queueToken !== airedToken) return 'auto';
  if (item.humanRequestId) return 'listener';
  return item.operator ? 'admin' : 'auto';
}
