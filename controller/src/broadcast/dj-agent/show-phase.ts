// Factual phase of the *incoming* show. Mirrors the queue's scheduled
// show-key resolver; never becomes a new show-policy or cue-out authority.
import { nextShowBoundaryMs, showKeyAt } from '../show-boundary.js';
import { showPhaseInfo } from './music-director-v2-core.js';

export function incomingShowPhase(at: Date | null): ReturnType<typeof showPhaseInfo> & {
  nextShowKey: string | null;
} {
  const now = at?.getTime() ?? Date.now();
  const next = nextShowBoundaryMs(now, 6 * 3600);
  const first = now - 6 * 3600_000;
  let last: number | null = null;
  let cursor = first;
  // A bounded scan over actual show boundaries rather than trusting a show's
  // nominal grid slot: takeovers and the default show are handled identically.
  for (let i = 0; i < 72 && cursor < now; i++) {
    const b = nextShowBoundaryMs(cursor, Math.ceil((now - cursor) / 1000));
    if (b === null || b >= now) break;
    last = b;
    cursor = b + 60_000;
  }
  return { ...showPhaseInfo(now, last, next),
    nextShowKey: next === null ? null : showKeyAt(next + 60_000) };
}
