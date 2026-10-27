export type TrackPresentationPhase = 'stable' | 'decay' | 'rewrite';

export interface HandoffLease {
  isCurrent: () => boolean;
  cancel: () => void;
}

/** A visual handoff is valid only while its phase and identity snapshot both exist. */
export function isTrackHandoffActive<T>(
  phase: TrackPresentationPhase,
  presentation: T | null,
): presentation is T {
  return phase !== 'stable' && presentation !== null;
}

export function shouldResetTrackHandoffStyles<T>(
  phase: TrackPresentationPhase,
  presentation: T | null,
): boolean {
  return !isTrackHandoffActive(phase, presentation);
}

/** State to commit atomically before the handoff-only paint styles are cleared. */
export function settledTrackPresentation<T>() {
  return { phase: 'stable' as const, presentation: null as T | null };
}

/** Async work remains owned by the transition that started it. */
export function createHandoffLease(): HandoffLease {
  let current = true;
  return {
    isCurrent: () => current,
    cancel: () => { current = false; },
  };
}

/** A foreground refresh is a one-shot event, not a persistent display mode. */
export function createReconciliationGate() {
  let consumed = 0;
  return {
    consume(id: number): boolean {
      if (!Number.isFinite(id) || id <= 0 || id === consumed) return false;
      consumed = id;
      return true;
    },
  };
}
