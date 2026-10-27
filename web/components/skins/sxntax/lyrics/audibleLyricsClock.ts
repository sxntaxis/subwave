/**
 * An Icecast stream has no per-song media timestamps. The controller tells us
 * which song is on air; the HTMLAudioElement tells us how much audio was really
 * consumed by this listener. Once anchored, advance lyrics with decoded media
 * time, not wall or network time. A stalled media clock must not advance words.
 *
 * This cannot detect a server-side discontinuity that replaces audio without
 * updating media time. Re-anchor on track change or media-source replacement.
 */
export type AudibleClockSample = Readonly<{
  stationPositionMs: number | null;
  mediaTimeSeconds: number | null;
  mediaSource: string | null;
  playing: boolean;
  stationPaused?: boolean;
  monoMs: number;
}>;
export type AudibleClockResult = Readonly<{
  positionMs: number | null;
  mode: 'station' | 'media' | 'stalled' | 'unavailable';
  stationDeltaMs: number | null;
}>;

export interface AudibleLyricsClock {
  observe(sample: AudibleClockSample): AudibleClockResult;
  reset(): void;
}

export function createAudibleLyricsClock(): AudibleLyricsClock {
  let anchorMedia: number | null = null;
  let anchorPosition: number | null = null;
  let anchorMono: number | null = null;
  let source: string | null = null;
  let previousMedia: number | null = null;
  let previousPosition: number | null = null;
  let previousMono: number | null = null;
  let stalled = false;
  const reset = () => {
    anchorMedia = null; anchorPosition = null; anchorMono = null; source = null;
    previousMedia = null; previousPosition = null; previousMono = null; stalled = false;
  };
  return {
    reset,
    observe({ stationPositionMs, mediaTimeSeconds, mediaSource, playing, stationPaused = false, monoMs }) {
      const station = stationPositionMs !== null && Number.isFinite(stationPositionMs) && stationPositionMs >= 0
        ? stationPositionMs : null;
      const media = mediaTimeSeconds !== null && Number.isFinite(mediaTimeSeconds) && mediaTimeSeconds >= 0
        ? mediaTimeSeconds : null;
      if (!Number.isFinite(monoMs)) return { positionMs: previousPosition, mode: 'unavailable', stationDeltaMs: null };
      if (source !== mediaSource && source !== null) reset();
      source = mediaSource;
      if (media === null || !mediaSource) {
        // No decoded media clock yet. Server timing is the safe provisional
        // estimate, rather than manufacturing an arbitrary playback offset.
        previousPosition = station ?? previousPosition;
        return { positionMs: previousPosition, mode: station === null ? 'unavailable' : 'station', stationDeltaMs: null };
      }
      // A new media element, stream reset, or seek is a real discontinuity.
      if (previousMedia !== null && media < previousMedia - 0.15) {
        anchorMedia = null; anchorPosition = null; stalled = false;
      }
      if (anchorMedia === null) {
        if (station === null) return { positionMs: previousPosition, mode: 'unavailable', stationDeltaMs: null };
        anchorMedia = media;
        anchorPosition = station;
        anchorMono = monoMs;
      }
      if (stationPaused) {
        // The source paused but Icecast may continue delivering silence. Freeze
        // the lyric position and reanchor the media timeline when it resumes.
        const frozen = previousPosition ?? station;
        previousMedia = media;
        previousMono = monoMs;
        previousPosition = frozen;
        anchorMedia = null;
        anchorPosition = null;
        anchorMono = null;
        stalled = true;
        return {positionMs: frozen, mode: 'stalled', stationDeltaMs: station === null || frozen === null ? null : station - frozen};
      }
      const mediaAdvance = previousMedia === null ? 0 : media - previousMedia;
      const monoAdvance = previousMono === null ? 0 : Math.max(0, monoMs - previousMono);
      // Detect buffering only after at least 600ms with no decoded progress.
      // A normal browser callback can arrive between decoder ticks: don't
      // classify each small stationary sample as a stall.
      if (!playing || (monoAdvance >= 600 && mediaAdvance < 0.04)) stalled = true;
      else if (mediaAdvance > 0) stalled = false;
      let position = Math.max(0, anchorPosition! + (media - anchorMedia) * 1000);
      // Distinguish server metadata correction from a *real* decoder stall.
      // If 2s elapsed on the monotonic clock but only 0s of audio was consumed,
      // those 2s of server/media disagreement are expected buffering debt and
      // MUST NOT be erased just because /now-playing returns to 121ms latency.
      // A server start timestamp that was corrected by 2s while media kept
      // advancing has no such debt and should converge automatically.
      const mediaLag = anchorMono === null ? 0 : Math.max(0,
        monoMs - anchorMono - (media - anchorMedia) * 1000);
      const error = station === null ? null : station - position;
      // RAF samples usually advance by 16ms. Requiring >=40ms per sample
      // prevented timestamp correction at normal frame rates indefinitely.
      if (error !== null && mediaAdvance > 0 && playing && !stalled) {
        const residual = error - mediaLag;
        // Up to 0.85 seconds of metadata correction per healthy audio second.
        // This is deliberately bounded; decoded sound is never skipped/seeked.
        const budget = Math.max(0, monoAdvance) * 0.85;
        const correction = Math.max(-budget, Math.min(budget, residual));
        anchorPosition! += correction;
        position = Math.max(0, position + correction);
      }
      previousMedia = media;
      previousMono = monoMs;
      previousPosition = position;
      return { positionMs: position, mode: stalled ? 'stalled' : 'media', stationDeltaMs: error };
    },
  };
}
