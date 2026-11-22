// Durable station-local MI v2.3 direction state. Human authority outranks the
// optional Agent proposal. Playback verification, not enqueuing, advances it.
import { existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { STATE_DIR } from '../../config.js';
import {
  advanceDirection, empty, date, bounded, clip, live,
  type DirectionRecord, type DirectionScope, type AdminMotion,
  type MovementProposal, type MusicSteer, type MusicMovement,
} from './music-direction-core.js';
export { advanceDirection } from './music-direction-core.js';
export type { DirectionScope, AdminMotion, MovementProposal, MusicSteer, MusicMovement } from './music-direction-core.js';

export const musicalDirectionEnabled = () => process.env.SUBWAVE_MUSIC_DIRECTION_V1 === '1';
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
        lastStart: typeof data.lastStart === 'string' ? data.lastStart : null };
    } catch { /* corrupt or absent sidecar fails to a safe empty direction */ }
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
    if (!v || typeof v !== 'object' || !clip(v.movement, 100) || !clip(v.destination, 120)
      || !clip(v.next, 120) || !Number.isFinite(Date.parse(v.expiresAt))) return null;
    return { ...v, energy: ['build','release','hold','contrast'].includes(v.energy) ? v.energy : null, movement: clip(v.movement, 100), destination: clip(v.destination, 120), next: clip(v.next, 120) };
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
    const movement = s.movement && s.movement.showId === showId && live(s.movement.expiresAt, now) ? s.movement : null;
    return { revision: s.revision, steering, movement, replanDue: !movement };
  }
  revision(): number { return this.state.revision; }
  /** Allows watcher restart to recognize the same mixer-stamped airing. */
  alreadyObservedStart(eventId: string): boolean {
    return this.enabled && !!eventId && this.state.lastStart === eventId;
  }
  /** Admission fence: even an unresolved person supersedes a speculative pick. */
  humanAdmitted() {
    if (!this.enabled) return;
    this.save({ ...this.state, revision: this.state.revision + 1, pending: null, movement: null });
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
    this.save({ ...this.state, revision: this.state.revision + 1, steering: steer, movement: null, pending: null });
    return this.snapshot(input.showId, now);
  }
  clear(showId: string | null) {
    if (!this.enabled) throw new Error('musical direction feature is disabled');
    this.save({ ...this.state, revision: this.state.revision + 1, steering: null, movement: null, pending: null });
    return this.snapshot(showId);
  }
  offerProposal(trackId: string, revision: number, showId: string | null, proposal: MovementProposal | null) {
    if (!this.enabled || !proposal || !trackId || revision !== this.state.revision) return false;
    // One movement owns its horizon. Per-song output cannot reset the clock
    // indefinitely; only a real human reroute or expiry permits replanning.
    if (this.snapshot(showId)?.movement || this.state.pending) return false;
    const parsed = {
      movement: clip(proposal.movement, 100), destination: clip(proposal.destination, 120),
      next: clip(proposal.next, 120), horizonMinutes: bounded(Math.floor(proposal.horizonMinutes), 15, 40),
      energy: ['build','release','hold','contrast'].includes(proposal.energy ?? '') ? proposal.energy : null,
    };
    if (!parsed.movement || !parsed.destination || !parsed.next || !Number.isFinite(parsed.horizonMinutes)) return false;
    this.state = { ...this.state, pending: { trackId, revision, showId, proposal: parsed } };
    // Pending stays in-memory, never authoritative until actual play.
    return true;
  }
  onTrackStarted(start: Parameters<typeof advanceDirection>[1]) {
    if (!this.enabled) return;
    const next = advanceDirection(this.state, start);
    if (next === this.state) return;
    this.save(next);
  }
}

export const musicDirection = new MusicDirectionStore();
