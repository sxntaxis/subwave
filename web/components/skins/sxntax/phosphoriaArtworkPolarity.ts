/** Polarity follows Kawarp's artwork crossfade, never the semantic title swap.
 * Kawarp mixes its two low-resolution artwork textures channel-by-channel;
 * sample that same mixture before applying sRGB relative luminance.
 */
export type ArtworkRgb = readonly [number, number, number];

export interface ArtworkPolarityFade {
  readonly source: string;
  readonly from: ArtworkRgb;
  readonly startedAt: number;
  readonly durationMs: number;
}

export function parseArtworkRgb(value: string | null): ArtworkRgb | null {
  if (!value) return null;
  const match = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i.exec(value);
  if (!match) return null;
  const channels = [Number(match[1]), Number(match[2]), Number(match[3])];
  return channels.every(c => Number.isFinite(c) && c >= 0 && c <= 255)
    ? channels as unknown as ArtworkRgb : null;
}

export function blendArtworkRgb(from: ArtworkRgb, to: ArtworkRgb, amount: number): ArtworkRgb {
  const t = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ];
}

export function artworkFadeProgress(fade: ArtworkPolarityFade, now: number): number {
  if (!Number.isFinite(now) || !(fade.durationMs > 0)) return 0;
  return Math.min(1, Math.max(0, (now - fade.startedAt) / fade.durationMs));
}

export function artworkFadeColor(fade: ArtworkPolarityFade, target: ArtworkRgb | null, now: number): ArtworkRgb {
  // If the new artwork's colours have not been sampled yet, preserve the
  // current readable polarity; never treat a pending extraction as black.
  return target ? blendArtworkRgb(fade.from, target, artworkFadeProgress(fade, now)) : fade.from;
}

export function artworkLuminance(rgb: ArtworkRgb): number {
  const toLinear = (channel: number) => {
    const c = Math.max(0, Math.min(1, channel / 255));
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);
}

/** 0.40/0.53 hysteresis is inherited from SXNTAX's original polarity rule. */
export function nextArtworkPolarity(previous: boolean, rgb: ArtworkRgb): boolean {
  const luma = artworkLuminance(rgb);
  return previous ? luma >= 0.40 : luma >= 0.53;
}
