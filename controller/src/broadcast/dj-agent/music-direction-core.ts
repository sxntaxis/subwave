// MI v2.3: pure direction lifecycle. No queue, disk or LLM dependence.
import { randomUUID } from 'node:crypto';
import { rememberAirplay, resolveMemory, emptyMemory, progressAt, type EditorialMemory, type MovementProgress, type DirectionDevelopment } from './music-director-v2-core.js';
import type { DirectorV3Decision } from './director-v3-core.js';

export type DirectionScope = 'current-show' | 'fixed-duration' | 'station';
export type AdminMotion = 'pivot' | 'hold' | 'lift' | 'release';
// Shared caps for model-facing direction text and its durable/API projection.
// These are intentionally long enough for complete editorial instructions.
export const DIRECTION_TEXT_LIMITS = {
  movement: 300,
  destination: 400,
  next: 400,
  alternate: 400,
  reason: 400,
} as const;
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
  progress?: MovementProgress;
  plannedBy?: 'director-v3';
  /** Private migration marker for movements written with the expanded text caps. */
  textVersion?: 2;
  lastDecision?: DirectorV3Decision;
}
interface PendingProposal { trackId: string; token?: string; revision: number; showId: string | null; proposal?: MovementProposal; development?: DirectionDevelopment }
export interface DirectionRecord {
  version: 1;
  revision: number;
  steering: MusicSteer | null;
  movement: MusicMovement | null;
  pending: PendingProposal | null;
  lastStart: string | null;
  memory?: EditorialMemory;
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
  queueToken?: string | null; energy?: string | null; moods?: string[] | null; genre?: string | null;
  directorV2?: boolean;
}): DirectionRecord {
  if (!start.eventId || start.eventId === old.lastStart) return old;
  const s: DirectionRecord = { ...old, lastStart: start.eventId };
  if (start.directorV2) s.memory = rememberAirplay(old.memory ?? emptyMemory(), start);
  let steer = s.steering;
  if (steer && steer.scope === 'current-show' && steer.showId !== start.showId) steer = null;
  if (steer && !live(steer.expiresAt, start.at)) steer = null;
  if ((start.source === 'listener' || start.source === 'admin') && start.trackId) {
    if (start.directorV2 && s.movement) s.memory = resolveMemory(s.memory ?? emptyMemory(), {
      showId: s.movement.showId, movement: s.movement.movement, destination: s.movement.destination,
      outcome: 'human', endedAt: date(start.at), starts: s.movement.progress?.starts ?? 1,
    });
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
    if (start.directorV2) s.memory = resolveMemory(s.memory ?? emptyMemory(), {
      showId: s.movement.showId, movement: s.movement.movement, destination: s.movement.destination,
      outcome: s.movement.showId !== start.showId ? 'show-change' : 'expired',
      endedAt: date(start.at), starts: s.movement.progress?.starts ?? 1,
    });
    s.movement = null;
  }
  // Actual airplay, not time spent awaiting a model, advances the movement.
  // This is a descriptive progress estimate, never a claim that a sonic goal
  // has been reached from missing or inferred audio evidence.
  if (start.directorV2 && s.movement && start.source === 'auto') {
    const m = s.movement;
    const starts = (m.progress?.starts ?? 1) + 1;
    const artists = new Set((s.memory?.recent ?? []).filter(e => e.showId === start.showId)
      .map(e => e.artist?.toLowerCase()).filter(Boolean)).size;
    s.movement = { ...m, progress: progressAt(m.startedAt, start.at, starts, artists,
      start.trackId, m.progress?.alternate ?? null,
      Math.max(15, (Date.parse(m.expiresAt) - Date.parse(m.startedAt)) / 60_000)) };
  }
  if (s.pending) {
    if (s.pending.trackId === start.trackId && s.pending.revision === s.revision
      && s.pending.showId === start.showId
      // Flag-off parity: v2.3 never checked steering or queue identity here.
      // v2.4 instead requires a verified autonomous queue token and no human
      // direction, so an identical track ID cannot satisfy a different pick.
      && (start.directorV2
        ? start.source === 'auto' && !!s.pending.token
          && s.pending.token === start.queueToken && !s.steering
        : start.source !== 'listener')) {
      const p = s.pending.proposal;
      if (p && (!start.directorV2 || !s.movement)) {
        s.movement = {
          id: randomUUID(), movement: p.movement, destination: p.destination, next: p.next,
          energy: p.energy, originRevision: s.revision, showId: start.showId, startedAt: date(start.at),
          expiresAt: date(start.at + bounded(p.horizonMinutes, 15, 40) * 60_000),
          ...(start.directorV2 ? { progress: progressAt(date(start.at), start.at, 1, 1, start.trackId, null, p.horizonMinutes) } : {}),
        };
      }
      const d = s.pending.development;
      if (d && s.movement && start.directorV2) {
        if (d.decision === 'resolve' || d.decision === 'reroute') {
          s.memory = resolveMemory(s.memory ?? emptyMemory(), {
            showId: s.movement.showId, movement: s.movement.movement, destination: s.movement.destination,
            outcome: d.decision === 'resolve' ? 'resolved' : 'rerouted', endedAt: date(start.at),
            starts: s.movement.progress?.starts ?? 1,
            followOn: d.next, alternate: d.alternate,
          });
          s.movement = null;
        } else {
          s.movement = { ...s.movement, next: d.next,
            progress: { ...(s.movement.progress ?? progressAt(s.movement.startedAt, start.at, 1, 1, start.trackId, null, 30)), alternate: d.alternate } };
        }
      }
    }
    s.pending = null; // no phantom future plan after a different real track
  }
  s.steering = steer;
  return s;
}
