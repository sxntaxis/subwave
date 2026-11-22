// MI v2.3: pure direction lifecycle. No queue, disk or LLM dependence.
import { randomUUID } from 'node:crypto';

export type DirectionScope = 'current-show' | 'fixed-duration' | 'station';
export type AdminMotion = 'pivot' | 'hold' | 'lift' | 'release';
export interface MovementProposal {
  movement: string;
  destination: string;
  next: string;
  horizonMinutes: number;
  energy: 'build' | 'release' | 'hold' | 'contrast' | null;
}
export interface MusicSteer {
  id: string;
  source: 'listener' | 'admin';
  kind: 'song-anchor' | AdminMotion;
  intent: string;
  showId: string | null;
  scope: DirectionScope;
  anchorTrackId: string | null;
  anchorAt: string | null;
  createdAt: string;
  expiresAt: string | null;
  remainingStarts: number | null;
  followedStarts: number;
}
export interface MusicMovement {
  id: string;
  movement: string;
  destination: string;
  next: string;
  energy: MovementProposal['energy'];
  originRevision: number;
  showId: string | null;
  startedAt: string;
  expiresAt: string;
}
interface PendingProposal { trackId: string; revision: number; showId: string | null; proposal: MovementProposal }
export interface DirectionRecord {
  version: 1;
  revision: number;
  steering: MusicSteer | null;
  movement: MusicMovement | null;
  pending: PendingProposal | null;
  lastStart: string | null;
}
export const empty = (): DirectionRecord => ({ version: 1, revision: 0, steering: null, movement: null, pending: null, lastStart: null });
export const date = (ms: number) => new Date(ms).toISOString();
export const bounded = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
export const clip = (v: unknown, max = 180): string => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';
export const live = (iso: string | null, now: number) => iso === null || (Number.isFinite(Date.parse(iso)) && Date.parse(iso) > now);

/** Pure advancement: no side effect on unverified/duplicate metadata ticks. */
export function advanceDirection(old: DirectionRecord, start: {
  eventId: string; trackId: string | null; title: string; artist: string | null;
  source: 'listener' | 'admin' | 'auto'; showId: string | null; at: number;
}): DirectionRecord {
  if (!start.eventId || start.eventId === old.lastStart) return old;
  const s: DirectionRecord = { ...old, lastStart: start.eventId };
  let steer = s.steering;
  if (steer && steer.scope === 'current-show' && steer.showId !== start.showId) steer = null;
  if (steer && !live(steer.expiresAt, start.at)) steer = null;
  if ((start.source === 'listener' || start.source === 'admin') && start.trackId) {
    // An accepted listener's *actual song* is the anchor. No generated words
    // or unverified queue events can activate this steering.
    if (!steer || steer.source !== 'admin' || (start.source === 'admin' && steer.kind === 'song-anchor')) {
      const humanIsAdmin = start.source === 'admin';
      steer = {
        id: randomUUID(), source: humanIsAdmin ? 'admin' : 'listener', kind: 'song-anchor',
        intent: clip(`Continue naturally from ${start.title}${start.artist ? ' — ' + start.artist : ''}`, 180),
        showId: start.showId, scope: 'current-show', anchorTrackId: start.trackId,
        anchorAt: date(start.at), createdAt: date(start.at),
        expiresAt: date(start.at + (humanIsAdmin ? 45 : 20) * 60_000),
        remainingStarts: humanIsAdmin ? 6 : 4, followedStarts: 0,
      };
      s.movement = null;
      s.pending = null;
    }
  } else if (steer && steer.anchorAt && start.at > Date.parse(steer.anchorAt)) {
    const count = steer.followedStarts + 1;
    steer = { ...steer, followedStarts: count,
      remainingStarts: steer.remainingStarts === null ? null : Math.max(0, steer.remainingStarts - 1) };
    if (steer.remainingStarts === 0) steer = null;
  }
  if (s.movement && (s.movement.showId !== start.showId || !live(s.movement.expiresAt, start.at))) {
    s.movement = null;
  }
  if (s.pending) {
    if (s.pending.trackId === start.trackId && s.pending.revision === s.revision
      && s.pending.showId === start.showId && start.source !== 'listener') {
      const p = s.pending.proposal;
      s.movement = {
        id: randomUUID(), movement: p.movement, destination: p.destination, next: p.next,
        energy: p.energy, originRevision: s.revision, showId: start.showId, startedAt: date(start.at),
        expiresAt: date(start.at + bounded(p.horizonMinutes, 15, 40) * 60_000),
      };
    }
    s.pending = null; // no phantom future plan after a different real track
  }
  s.steering = steer;
  return s;
}
