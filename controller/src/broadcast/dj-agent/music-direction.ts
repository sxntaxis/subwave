// Durable station-local MI v2.3 direction state. Human authority outranks the
// optional Agent proposal. Playback verification, not enqueuing, advances it.
import { existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { STATE_DIR } from '../../config.js';
import { logEvent } from '../../observability/events.js';
import { emptyMemory, musicalMemoryView, resolveMemory, progressAt, type EditorialMemory, type DirectionDevelopment } from './music-director-v2-core.js';
import {
  advanceDirection, empty, date, bounded, clip, live,
  DIRECTION_TEXT_LIMITS,
  type DirectionRecord, type DirectionScope, type AdminMotion,
  type MovementProposal, type MusicSteer, type MusicMovement,
} from './music-direction-core.js';
export { advanceDirection } from './music-direction-core.js';
export type { DirectionScope, AdminMotion, MovementProposal, MusicSteer, MusicMovement } from './music-direction-core.js';

import { boundedDirectorReason, validDirectorSeed, validDirectorReview } from './director-v3-core.js';

export const directorV3Enabled = () => musicalDirectorV2Enabled() && process.env.SUBWAVE_MUSIC_TRAJECTORY_V1 === '1'
  && process.env.SUBWAVE_MI_DIRECTOR_V3 === '1';

export const musicalDirectionEnabled = () => process.env.SUBWAVE_MUSIC_DIRECTION_V1 === '1';
export const musicalDirectorV2Enabled = () => musicalDirectionEnabled() && process.env.SUBWAVE_MUSIC_DIRECTOR_V2 === '1';
export class MusicDirectionStore {
  private state: DirectionRecord = empty();
  constructor(private readonly file = join(STATE_DIR, 'music-direction-v1.json'), private readonly enabled = musicalDirectionEnabled()) {
    if (!enabled || !existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data?.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0) return;
      this.state = { version: 1, revision: data.revision,
        steering: this.validSteer(data.steering), movement: this.validMovement(data.movement),
        pending: null, // a process-local pick may have been invalidated by restart
        lastStart: typeof data.lastStart === 'string' ? data.lastStart : null,
        memory: this.validMemory(data.memory) };
    } catch { /* corrupt or absent sidecar fails to a safe empty direction */ }
  }
  private validMemory(value: any): EditorialMemory {
    if (!value || !Array.isArray(value.recent) || !Array.isArray(value.resolved)) return emptyMemory();
    // Never accept arbitrarily large or malformed persisted envelopes. Old
    // sidecars have no memory field and naturally begin with an empty ledger.
    return {
      recent: value.recent.slice(0, 48).filter((e: any) => e && typeof e.eventId === 'string'
        && e.eventId.length <= 220 && Number.isFinite(Date.parse(e.at))
        && (typeof e.showId === 'string' || e.showId === null)
        && (typeof e.trackId === 'string' || e.trackId === null)
        && (typeof e.artist === 'string' || e.artist === null)
        && (typeof e.energy === 'string' || e.energy === null)
        && (typeof e.genre === 'string' || e.genre === null) && Array.isArray(e.moods)),
      resolved: value.resolved.slice(0, 12).filter((e: any) => e
        && typeof e.movement === 'string' && e.movement.length <= DIRECTION_TEXT_LIMITS.movement
        && typeof e.destination === 'string' && e.destination.length <= DIRECTION_TEXT_LIMITS.destination
        && ['resolved','rerouted','expired','show-change','human'].includes(e.outcome)
        && Number.isFinite(Date.parse(e.endedAt))).map((e: any) => {
          const { reason: _rawReason, ...rest } = e;
          return { ...rest,
            ...(e.followOn ? { followOn: clip(e.followOn, DIRECTION_TEXT_LIMITS.next) } : {}),
            ...(e.alternate ? { alternate: clip(e.alternate, DIRECTION_TEXT_LIMITS.alternate) } : {}),
            ...(clip(e.reason, DIRECTION_TEXT_LIMITS.reason) ? { reason: clip(e.reason, DIRECTION_TEXT_LIMITS.reason) } : {}),
          };
        }),
    };
  }
  private validSteer(v: any): MusicSteer | null {
    if (!v || typeof v !== 'object' || !['listener','admin'].includes(v.source)
      || !clip(v.id, 100) || !clip(v.intent) || !['station','current-show','fixed-duration'].includes(v.scope)
      || typeof v.createdAt !== 'string' || !Number.isFinite(Date.parse(v.createdAt))) return null;
    if (v.remainingStarts !== null && (!Number.isSafeInteger(v.remainingStarts) || v.remainingStarts <= 0)) return null;
    if (v.expiresAt !== null && !Number.isFinite(Date.parse(v.expiresAt))) return null;
    return { ...v, intent: clip(v.intent), remainingStarts: v.remainingStarts === null ? null
      : bounded(v.remainingStarts, 1, 24) };
  }
  private validMovement(v: any): MusicMovement | null {
    if (!v || typeof v !== 'object' || !clip(v.movement, DIRECTION_TEXT_LIMITS.movement)
      || !clip(v.destination, DIRECTION_TEXT_LIMITS.destination)
      || !clip(v.next, DIRECTION_TEXT_LIMITS.next) || !Number.isFinite(Date.parse(v.expiresAt))) return null;
    // The old Director caps sliced text at 100/120 characters. A v3 movement
    // persisted at any of those exact limits may end mid-instruction. Discard
    // that legacy movement at load; new movements carry textVersion: 2.
    const legacyDirectorTextWasCapped = v.plannedBy === 'director-v3' && v.textVersion !== 2
      && (v.movement.length === 100 || v.destination.length === 120 || v.next.length === 120);
    if (legacyDirectorTextWasCapped) return null;
    const p = v.progress;
    const progress = p && Number.isSafeInteger(p.starts) && p.starts >= 1 && p.starts <= 1000
      && Number.isFinite(p.elapsedMinutes) && p.elapsedMinutes >= 0 && p.elapsedMinutes < 10_000
      && ['establishing','developing','resolving'].includes(p.phase)
      && Number.isFinite(Date.parse(p.lastAt))
      ? { starts: p.starts, elapsedMinutes: p.elapsedMinutes, lastAt: p.lastAt,
          lastTrackId: clip(p.lastTrackId, 100) || null,
          distinctArtists: Number.isSafeInteger(p.distinctArtists) ? bounded(p.distinctArtists, 0, 1000) : 0,
          phase: p.phase, alternate: clip(p.alternate, DIRECTION_TEXT_LIMITS.alternate) || null } : undefined;
    const { plannedBy: _rawPlannedBy, textVersion: _rawTextVersion, lastDecision: _rawLastDecision, ...rest } = v;
    return { ...rest, energy: ['build','release','hold','contrast'].includes(v.energy) ? v.energy : null,
       movement: clip(v.movement, DIRECTION_TEXT_LIMITS.movement),
       destination: clip(v.destination, DIRECTION_TEXT_LIMITS.destination),
       next: clip(v.next, DIRECTION_TEXT_LIMITS.next),
       ...(progress ? { progress } : {}),
       ...(v.plannedBy === 'director-v3' ? { plannedBy: 'director-v3' as const } : {}),
       ...(v.textVersion === 2 ? { textVersion: 2 as const } : {}),
      ...(v.lastDecision && ['seed','continue','resolve','reroute'].includes(v.lastDecision.decision)
        && typeof v.lastDecision.eventId === 'string' && v.lastDecision.eventId.length <= 300
        && Number.isFinite(Date.parse(v.lastDecision.at)) && Number.isSafeInteger(v.lastDecision.starts)
        && v.lastDecision.starts >= 1 && v.lastDecision.starts <= 1000
        ? { lastDecision: { decision: v.lastDecision.decision, eventId: v.lastDecision.eventId,
          at: v.lastDecision.at, starts: v.lastDecision.starts, reason: boundedDirectorReason(v.lastDecision.reason) } } : {}),
    };
  }
  private save(next: DirectionRecord) {
    if (!this.enabled) return;
    // Same-directory atomic replacement. Never write raw listener messages,
    // credentials or LLM conversation into this private state.
    const tmp = join(dirname(this.file), `.direction-${process.pid}-${randomUUID()}.tmp`);
    try {
      const fd = openSync(tmp, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ ...next, pending: null })); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(tmp, this.file);
      this.state = next;
    } catch (err) { try { unlinkSync(tmp); } catch {} throw err; }
  }
  snapshot(showId: string | null, now = Date.now()) {
    if (!this.enabled) return null;
    const s = this.state;
    const steering = s.steering && live(s.steering.expiresAt, now)
      && (s.steering.scope !== 'current-show' || s.steering.showId === showId) ? s.steering : null;
    const rawMovement = s.movement && s.movement.showId === showId && live(s.movement.expiresAt, now) ? s.movement : null;
    const publicMovement = rawMovement
      ? (({ textVersion: _privateTextVersion, ...movement }) => movement)(rawMovement)
      : null;
    // Private idempotency keys never enter the API or LLM prompt snapshot.
    const movement = publicMovement?.lastDecision
      ? { ...publicMovement, lastDecision: { decision: publicMovement.lastDecision.decision,
        at: publicMovement.lastDecision.at, starts: publicMovement.lastDecision.starts,
        reason: publicMovement.lastDecision.reason } }
      : publicMovement;
    return { revision: s.revision, steering, movement, replanDue: !movement,
      ...(musicalDirectorV2Enabled() ? { directorVersion: 2,
        memory: musicalMemoryView(s.memory ?? emptyMemory(), showId) } : {}) };
  }
  // Private, verified-only identity feed for optional acoustic trajectory reads.
  // A picked/enqueued item does not enter this ledger until the mixer starts it.
  recentVerifiedStarts(showId: string | null, limit = 8, since: string | null = null) {
    if (!this.enabled) return [];
    return (this.state.memory?.recent ?? []).filter(s => s.showId === showId && !!s.trackId
      && (since === null || Number.isFinite(Date.parse(since)) && Date.parse(s.at) >= Date.parse(since)))
      .slice(0, Math.min(8, Math.max(0, limit)))
      .map(s => ({ eventId: s.eventId, showId: s.showId, trackId: s.trackId }));
  }
  revision(): number { return this.state.revision; }
  /** Factual mixer-derived starts, without scoring eligibility or pending picks. */
  recentVerifiedAirplay(limit = 12) {
    if (!this.enabled || !musicalDirectorV2Enabled()) return [];
    return (this.state.memory?.recent ?? []).slice(0, Math.min(12, Math.max(0, limit)))
      .map(e => ({ ...e, moods: [...e.moods] }));
  }
  /** Allows watcher restart to recognize the same mixer-stamped airing. */
  alreadyObservedStart(eventId: string): boolean {
    return this.enabled && !!eventId && this.state.lastStart === eventId;
  }
  /** Admission fence: even an unresolved person supersedes a speculative pick. */
  humanAdmitted() {
    if (!this.enabled) return;
    const memory = this.endedByHuman(Date.now());
    this.save({ ...this.state, memory, revision: this.state.revision + 1, pending: null, movement: null });
    if (musicalDirectorV2Enabled()) logEvent('direction.human_admitted', { revision: this.state.revision });
  }
  private endedByHuman(now: number): EditorialMemory {
    const memory = this.state.memory ?? emptyMemory();
    const m = this.state.movement;
    return musicalDirectorV2Enabled() && m ? resolveMemory(memory, {
      showId: m.showId, movement: m.movement, destination: m.destination,
      outcome: 'human', endedAt: date(now), starts: m.progress?.starts ?? 1,
    }) : memory;
  }
  setAdmin(input: { kind: AdminMotion; intent: string; scope: DirectionScope;
    durationMinutes?: number; followingTracks?: number; showId: string | null }, now = Date.now()) {
    if (!this.enabled) throw new Error('musical direction feature is disabled');
    const intent = clip(input.intent);
    if (!intent || intent.length > 180) throw new Error('invalid admin musical intent');
    const scope = input.scope;
    if (!['station','current-show','fixed-duration'].includes(scope)) throw new Error('invalid steering scope');
    const duration = bounded(Math.floor(input.durationMinutes ?? 45), 1, 180);
    const following = bounded(Math.floor(input.followingTracks ?? 8), 1, 24);
    const steer: MusicSteer = {
      id: randomUUID(), source: 'admin', kind: input.kind, intent,
      scope, showId: input.showId, anchorTrackId: null, anchorAt: date(now), createdAt: date(now),
      expiresAt: scope === 'station' ? null : date(now + duration * 60_000),
      remainingStarts: scope === 'station' ? null : following, followedStarts: 0,
    };
    this.save({ ...this.state, memory: this.endedByHuman(now),
      revision: this.state.revision + 1, steering: steer, movement: null, pending: null });
    if (musicalDirectorV2Enabled()) logEvent('direction.admin', {
      kind: input.kind, scope, revision: this.state.revision });
    return this.snapshot(input.showId, now);
  }
  clear(showId: string | null) {
    if (!this.enabled) throw new Error('musical direction feature is disabled');
    this.save({ ...this.state, memory: this.endedByHuman(Date.now()),
      revision: this.state.revision + 1, steering: null, movement: null, pending: null });
    if (musicalDirectorV2Enabled()) logEvent('direction.cleared', { revision: this.state.revision });
    return this.snapshot(showId);
  }
  offerProposal(trackId: string, revision: number, showId: string | null, proposal: MovementProposal | null, token?: string | null, maxHorizonMinutes?: number | null) {
    if (!this.enabled || !proposal || !trackId || revision !== this.state.revision) return false;
    // One movement owns its horizon. Per-song output cannot reset the clock
    // indefinitely; only a real human reroute or expiry permits replanning.
    if (this.snapshot(showId)?.movement || this.state.pending) return false;
    if (musicalDirectorV2Enabled() && (this.snapshot(showId)?.steering || !token)) return false;
    if (musicalDirectorV2Enabled() && maxHorizonMinutes !== undefined && maxHorizonMinutes !== null
      && maxHorizonMinutes < 15) return false;
    const parsed = {
      movement: clip(proposal.movement, DIRECTION_TEXT_LIMITS.movement),
      destination: clip(proposal.destination, DIRECTION_TEXT_LIMITS.destination),
      next: clip(proposal.next, DIRECTION_TEXT_LIMITS.next), horizonMinutes: bounded(Math.floor(proposal.horizonMinutes), 15,
        musicalDirectorV2Enabled() && maxHorizonMinutes != null
          ? Math.min(40, Math.max(15, Math.floor(maxHorizonMinutes))) : 40),
      energy: ['build','release','hold','contrast'].includes(proposal.energy ?? '') ? proposal.energy : null,
    };
    if (!parsed.movement || !parsed.destination || !parsed.next || !Number.isFinite(parsed.horizonMinutes)) return false;
    this.state = { ...this.state, pending: { trackId, ...(token ? { token } : {}), revision, showId, proposal: parsed } };
    if (musicalDirectorV2Enabled()) logEvent('direction.proposal', {
      showId, revision, kind: 'movement', horizonMinutes: parsed.horizonMinutes });
    // Pending stays in-memory, never authoritative until actual play.
    return true;
  }
  offerDevelopment(trackId: string, token: string | null, revision: number,
    showId: string | null, proposal: DirectionDevelopment | null) {
    if (!this.enabled || !musicalDirectorV2Enabled() || !proposal || !token || !trackId
      || revision !== this.state.revision || this.state.pending) return false;
    const snapshot = this.snapshot(showId);
    if (!snapshot?.movement || snapshot.steering) return false;
    if (!['continue','resolve','reroute'].includes(proposal.decision)) return false;
    const next = clip(proposal.next, DIRECTION_TEXT_LIMITS.next);
    const alternate = clip(proposal.alternate, DIRECTION_TEXT_LIMITS.alternate);
    if (!next || !alternate) return false;
    this.state = { ...this.state, pending: { trackId, token, revision, showId,
      development: { decision: proposal.decision, next, alternate } } };
    logEvent('direction.proposal', { showId, revision, kind: 'development', decision: proposal.decision });
    return true;
  }
  /** Autonomous v3 editorial commits are tied to an already persisted mixer
   * start. No queue selection, future song, or stale LLM response can activate
   * or revise a movement. The revision is reserved for human authority. */
  commitDirectorV3(input: {
    eventId: string; trackId: string; showId: string | null; at: number;
    expectedRevision: number; expectedMovementId: string | null;
    remainingMinutes: number | null;
    action: 'seed' | 'review'; output: unknown;
  }, onRejected?: (reason: string) => void): boolean {
    const reject = (reason: string) => {
      onRejected?.(reason);
      return false;
    };
    if (!this.enabled || !directorV3Enabled()) return reject('disabled');
    const s = this.state;
    const observed = s.memory?.recent[0];
    if (!input.eventId || s.lastStart !== input.eventId || !observed
      || observed.eventId !== input.eventId.slice(0, 220)
      || observed.trackId !== input.trackId || observed.showId !== input.showId
      ) return reject('stale-start');
    if (s.revision !== input.expectedRevision) return reject('stale-revision');
    if (s.pending) return reject('pending-direction');
    const now = Date.now();
    if (this.snapshot(input.showId, now)?.steering || !Number.isFinite(input.at)
      ) return reject('human-steering');
    if (!Number.isFinite(input.at) || input.at > now + 10_000 || now - input.at > 120_000) {
      return reject('stale-airtime');
    }
    const m = s.movement;
    if ((m?.id ?? null) !== input.expectedMovementId) return reject('movement-changed');
    const out = input.output as Record<string, unknown>;
    const reason = boundedDirectorReason(out?.reason);
    if (!reason) return reject('missing-reason');
    if (input.action === 'seed') {
      if (m) return reject('movement-exists');
      const proposal = validDirectorSeed(out, input.remainingMinutes);
      if (!proposal) return reject('invalid-seed');
      const startedAt = date(input.at);
      const lastDecision = { decision: 'seed' as const, at: date(now), starts: 1,
        eventId: input.eventId, reason };
      const movement: MusicMovement = {
        id: randomUUID(), movement: proposal.movement, destination: proposal.destination,
        next: proposal.next, energy: proposal.energy, originRevision: s.revision,
        showId: input.showId, startedAt, textVersion: 2,
        expiresAt: date(input.at + proposal.horizonMinutes * 60_000),
        plannedBy: 'director-v3', lastDecision,
        progress: progressAt(startedAt, input.at, 1, 1, input.trackId, null, proposal.horizonMinutes),
      };
      this.save({ ...s, movement });
      logEvent('direction.v3_commit', { kind: 'seed', showId: input.showId, eventId: input.eventId });
      return true;
    }
    if (!m || m.plannedBy !== 'director-v3') return reject('not-director-movement');
    if (m.lastDecision?.eventId === input.eventId) return reject('duplicate-review');
    const review = validDirectorReview(out);
    if (!review) return reject('invalid-review');
    const lastDecision = { decision: review.decision, at: date(now),
      starts: m.progress?.starts ?? 1, eventId: input.eventId, reason };
    if (review.decision === 'continue') {
      this.save({ ...s, movement: { ...m, next: review.next, lastDecision,
        progress: { ...(m.progress ?? progressAt(m.startedAt, input.at, 1, 1, input.trackId, null, 30)),
          alternate: review.alternate } } });
    } else {
      const memory = resolveMemory(s.memory ?? emptyMemory(), {
        showId: m.showId, movement: m.movement, destination: m.destination,
        outcome: review.decision === 'resolve' ? 'resolved' : 'rerouted',
        endedAt: date(now), starts: m.progress?.starts ?? 1,
        followOn: review.next, alternate: review.alternate, reason,
      });
      this.save({ ...s, memory, movement: null });
    }
    logEvent('direction.v3_commit', { kind: review.decision, showId: input.showId, eventId: input.eventId });
    return true;
  }
  onTrackStarted(start: Parameters<typeof advanceDirection>[1]) {
    if (!this.enabled) return;
    const next = advanceDirection(this.state, { ...start, directorV2: musicalDirectorV2Enabled() });
    if (next === this.state) return;
    const previous = this.state;
    this.save(next);
    if (musicalDirectorV2Enabled()) logEvent('direction.airplay', {
      showId: start.showId, verifiedHuman: start.source !== 'auto',
      movementStarted: !previous.movement && !!next.movement,
      movementEnded: !!previous.movement && !next.movement,
      movementContinued: !!previous.movement && !!next.movement,
      starts: next.movement?.progress?.starts ?? null,
    });
  }
}

export const musicDirection = new MusicDirectionStore();
