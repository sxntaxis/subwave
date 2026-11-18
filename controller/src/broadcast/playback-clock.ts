// Playback time is wall time minus idle-gate pauses. Keep the original airing
// timestamp intact: history, likes and scrobbles use it as identity.
export class PlaybackClock {
  private trackStart: number | null = null;
  private idleSince: number | null = null;
  private pausedMs = 0;

  private sync(startedAt: string | undefined) {
    const parsed = startedAt ? Date.parse(startedAt) : NaN;
    const start = Number.isFinite(parsed) ? parsed : null;
    if (start !== this.trackStart) {
      this.trackStart = start;
      this.pausedMs = 0;
    }
  }

  setIdle(idle: boolean, startedAt: string | undefined, now: number) {
    this.sync(startedAt);
    if (idle && this.idleSince == null) this.idleSince = now;
    if (!idle && this.idleSince != null) {
      if (this.trackStart != null) {
        this.pausedMs += Math.max(0, now - Math.max(this.trackStart, this.idleSince));
      }
      this.idleSince = null;
    }
  }

  snapshot(startedAt: string | undefined) {
    this.sync(startedAt);
    if (this.trackStart == null) return null;
    return {
      // An effective origin for progress only, not a new airing timestamp.
      startedAt: this.trackStart + this.pausedMs,
      pausedAt: this.idleSince == null ? null : Math.max(this.trackStart, this.idleSince),
    };
  }
}
