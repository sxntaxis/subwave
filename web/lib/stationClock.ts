/** The controller's epoch is authoritative; local performance.now() supplies only elapsed time.
 * Never compare server timestamps to the client's Date.now() after synchronization. */
export interface StationClock {
  /** Sample the controller response. Reject stale, very slow or malformed exchanges. */
  sample(serverTimeMs: number | null | undefined, sentMonoMs: number, receivedMonoMs: number): boolean;
  /** Estimated server epoch (ms), or null before a trustworthy sample. */
  nowMs(atMonoMs?: number): number | null;
  /** Estimated milliseconds until a server-epoch event. */
  delayMs(serverEpochMs: number, atMonoMs?: number): number | null;
  reset(): void;
}

export function createStationClock(monotonicNow: () => number = () => performance.now()): StationClock {
  let epochAtAnchor: number | null = null;
  let anchorMono = 0;
  let bestRtt = Number.POSITIVE_INFINITY;
  return {
    sample(serverTimeMs, sentMonoMs, receivedMonoMs) {
      const rtt = receivedMonoMs - sentMonoMs;
      if (typeof serverTimeMs !== 'number' || !Number.isFinite(serverTimeMs) ||
          serverTimeMs < 1_500_000_000_000 || serverTimeMs > 4_102_444_800_000 ||
          !Number.isFinite(sentMonoMs) || !Number.isFinite(receivedMonoMs) ||
          rtt < 0 || rtt > 4000) return false;
      // Server stamp is generated immediately before the JSON response; receive
      // time is later by approximately half RTT. Wall-clock offset is irrelevant.
      const candidate = serverTimeMs + rtt / 2;
      const existing = epochAtAnchor === null ? null : epochAtAnchor + receivedMonoMs - anchorMono;
      if (existing !== null && rtt > Math.max(150, bestRtt * 3)) return false;
      // Ignore normal network jitter; large discontinuities (sleep or station
      // restart) require an immediate new anchor rather than minutes of slewing.
      const error = existing === null ? 0 : candidate - existing;
      const correction = existing === null || Math.abs(error) > 2500
        ? candidate
        : existing + Math.max(-100, Math.min(100, error * 0.25));
      epochAtAnchor = correction;
      anchorMono = receivedMonoMs;
      bestRtt = Math.min(bestRtt, rtt);
      return true;
    },
    nowMs(atMonoMs = monotonicNow()) {
      if (epochAtAnchor === null || !Number.isFinite(atMonoMs)) return null;
      return epochAtAnchor + Math.max(0, atMonoMs - anchorMono);
    },
    delayMs(epochMs, atMonoMs = monotonicNow()) {
      const now = this.nowMs(atMonoMs);
      return now !== null && Number.isFinite(epochMs) ? Math.max(0, epochMs - now) : null;
    },
    reset() { epochAtAnchor = null; anchorMono = 0; bestRtt = Infinity; },
  };
}
