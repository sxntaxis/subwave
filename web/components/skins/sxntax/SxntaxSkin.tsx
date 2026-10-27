'use client';

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type RefObject,
} from 'react';
import styles from './Sxntax.module.css';
import RadioFrame from './RadioFrame';
import LyricsPerspective from './lyrics/LyricsPerspective';
import { useCurrentLyrics } from './lyrics/useCurrentLyrics';
import { canShowLyrics, shouldKeepLyricsScene, shouldShowRequestedLyrics } from './lyrics/lyricsMode';
import { presentedLyricPosition } from './lyrics/presentedLyricsClock';
import { lyricsOpeningScrollTop } from './lyrics/lyricsFrame';
import { useLyricsPresentation } from './lyrics/useLyricsPresentation';
import { safeLyricsPositionMs } from './lyrics/lyricsPosition';
import type { LyricsPreviewMode } from './lyrics/lyricsPreview';
import {
  usePlayerActions,
  usePlayerAudio,
  usePlayerFeed,
} from '@/components/player/PlayerCore';
import { useTuneInGate } from '@/components/player/useTuneInGate';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useLiteMode } from '@/hooks/useLiteMode';
import { useCoverColors } from '@/hooks/useCoverColors';
import { artworkFadeColor, nextArtworkPolarity, parseArtworkRgb, type ArtworkPolarityFade, type ArtworkRgb } from './phosphoriaArtworkPolarity';
import { useElapsed } from '@/hooks/useElapsed';
import { useClock } from '@/lib/hooks';
import { REQUEST_NAME_MAX, REQUEST_TEXT_MAX } from '@/lib/schemas.generated';
import { fmtTime, normalizeStationLocale } from '@/lib/format';
import { useStationClient } from '@/lib/stationClient';
import { buildAirHistory } from './airHistory';
import {
  createHandoffLease,
  createReconciliationGate,
  isTrackHandoffActive,
  settledTrackPresentation,
  shouldResetTrackHandoffStyles,
  type TrackPresentationPhase,
} from './trackPresentationState';
import {
  listenerCountOf,
  progressRatio,
  stationIdentity,
  turnClock,
} from '../shared';
import { useRequestSlip, useTrackLike, useVolumeNudge } from '../sharedHooks';
import type { SkinProps } from '../types';

type SxStyle = CSSProperties & Record<`--${string}`, string | number>;

type RendererMode = 'shell' | 'full' | 'lite';

type TrackBridgeTrack = {
  subsonic_id?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | string | null;
} | null;

type TrackTypographySnapshot = {
  titleSize: string;
  artistSize: string;
  albumSize: string;
  coverSize: string;
  artGap: string;
  copyWidth: string;
  renderedTitle: string;
  titleOpticalInset: string;
  artistOpticalInset: string;
  albumOpticalInset: string;
};

// The incoming probe is the authority for the first settled live frame.
// It is valid only for the exact track metadata and stage geometry measured.
type PreparedTrackFit = {
  key: string;
  title: string;
  artist: string;
  album: string;
  hasCover: boolean;
  stageWidth: number;
  stageHeight: number;
  typography: TrackTypographySnapshot;
};

type TrackHandoffPresentation = {
  outgoing: TrackBridgeTrack;
  incoming: TrackBridgeTrack;
  outgoingTypography: TrackTypographySnapshot | null;
  incomingTypography: TrackTypographySnapshot | null;
};

type TrackGeometrySource = {
  subsonic_id?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | string | null;
};

type TrackGeometry = {
  key: string;
  height: number;
  fit: PreparedTrackFit | null;
};

const FullEffects = lazy(() => import('./SxntaxFullEffects'));
const loadScheduleModal = () => import('./ScheduleModal');
const ScheduleModal = lazy(loadScheduleModal);
const AMBIENT_TRANSITION_MS = 10_000;
// Keep the station/Kawarp wash on its ten-second crossfade, but let the
// typographic identity settle one golden-ratio step sooner.
const TRACK_HANDOFF_MS = 6_180;
const TRACK_SWAP_PROGRESS = 0.5;
// Preserve the measured normal-scene corridor choreography. Lyrics mode opts
// out of this observer and uses the fixed viewport budget instead.
const TRACK_CORRIDOR_PREPOSITION_MS = TRACK_HANDOFF_MS;
const TRACK_CORRIDOR_GLIDE_MS = Math.round(TRACK_HANDOFF_MS * (1 - TRACK_SWAP_PROGRESS));
const GATE_RELEASE_MS_LITE = 0;
const GATE_RELEASE_MS_FULL = 1100;
const FULL_REVEAL_MS = 2200;


type TransitionTuning = {
  peakExponent: number;
  massBlur: number;
  flicker: number;
  noise: number;
  curvature: number;
};

const DEFAULT_TRANSITION_TUNING: TransitionTuning = {
  peakExponent: 7.0,
  massBlur: 14,
  flicker: 1.35,
  noise: 0.34,
  curvature: 0.22,
};

function readTransitionTuning(): TransitionTuning {
  if (typeof window === 'undefined') return DEFAULT_TRANSITION_TUNING;
  const params = new URLSearchParams(window.location.search);
  const read = (name: string, fallback: number, min: number, max: number) => {
    const value = Number.parseFloat(params.get(name) ?? '');
    return Number.isFinite(value) ? clampNumber(value, min, max) : fallback;
  };
  return {
    peakExponent: read('sxPeak', DEFAULT_TRANSITION_TUNING.peakExponent, 1.5, 12),
    massBlur: read('sxMassBlur', DEFAULT_TRANSITION_TUNING.massBlur, 8, 32),
    flicker: read('sxFlicker', DEFAULT_TRANSITION_TUNING.flicker, 0, 5),
    noise: read('sxNoise', DEFAULT_TRANSITION_TUNING.noise, 0, 2),
    curvature: read('sxCurve', DEFAULT_TRANSITION_TUNING.curvature, 0, 1),
  };
}

function trackIdentity(track: { subsonic_id?: string | null; title?: string | null; artist?: string | null } | null): string {
  if (!track) return 'none';
  if (track.subsonic_id) return `id:${track.subsonic_id}`;
  return `meta:${track.title ?? ''}\u0000${track.artist ?? ''}`;
}

function LiteAmbient() {
  return <div className={styles.liteAmbient} aria-hidden="true" />;
}


function stationClockSeconds(now: Date | null, timezone: string | null, locale: string): string {
  if (!now) return '';
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: timezone ?? undefined,
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(now);
  }
}

function hasCjk(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u.test(text);
}

const PHI = 1.618033988749895;
const PHI2 = PHI * PHI;
const PHI4 = PHI2 * PHI2;

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep01(value: number): number {
  const t = clampNumber(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function readTrackTypography(stage: HTMLElement | null): TrackTypographySnapshot | null {
  if (!stage) return null;
  const style = getComputedStyle(stage);
  const copy = stage.querySelector<HTMLElement>('[data-hero-copy]');
  const title = stage.querySelector<HTMLElement>('[data-phosphor-text]');
  return {
    titleSize: style.getPropertyValue('--sx-title-size').trim(),
    artistSize: style.getPropertyValue('--sx-artist-size').trim(),
    albumSize: style.getPropertyValue('--sx-album-size').trim(),
    coverSize: style.getPropertyValue('--sx-cover-size').trim(),
    artGap: style.getPropertyValue('--sx-art-gap').trim(),
    copyWidth: copy ? `${copy.getBoundingClientRect().width}px` : '',
    renderedTitle: title?.textContent?.trim() ?? '',
    titleOpticalInset: style.getPropertyValue('--sx-title-optical-inset').trim(),
    artistOpticalInset: style.getPropertyValue('--sx-artist-optical-inset').trim(),
    albumOpticalInset: style.getPropertyValue('--sx-album-optical-inset').trim(),
  };
}

/** The hidden, independent probe is the sole source of normal-scene height.
 * Never measure the live corridor after writing a height back to it. */
function measureTrackGeometry(
  key: string,
  track: TrackGeometrySource | null,
  stage: HTMLElement | null,
  node: HTMLElement | null,
): TrackGeometry | null {
  if (!node) return null;
  const height = node.getBoundingClientRect().height;
  if (height <= 0) return null;
  const typography = readTrackTypography(stage);
  const title = track?.title ?? 'Somewhere on the dial';
  const artist = track?.artist ?? 'Unknown artist';
  const album = [track?.album, track?.year].filter(Boolean).join(' · ') || 'live broadcast';
  return {
    key,
    height,
    fit: stage && typography ? {
      key,
      title,
      artist,
      album,
      hasCover: Boolean(track?.subsonic_id),
      stageWidth: stage.clientWidth,
      stageHeight: stage.clientHeight,
      typography,
    } : null,
  };
}

function typographySnapshotStyle(snapshot: TrackTypographySnapshot | null): SxStyle | undefined {
  if (!snapshot) return undefined;
  return {
    '--sx-title-size': snapshot.titleSize,
    '--sx-artist-size': snapshot.artistSize,
    '--sx-album-size': snapshot.albumSize,
    '--sx-cover-size': snapshot.coverSize,
    '--sx-art-gap': snapshot.artGap,
    '--sx-bridge-copy-width': snapshot.copyWidth,
    '--sx-title-optical-inset': snapshot.titleOpticalInset,
    '--sx-artist-optical-inset': snapshot.artistOpticalInset,
    '--sx-album-optical-inset': snapshot.albumOpticalInset,
  };
}

function bridgeTitle(track: TrackBridgeTrack, snapshot: TrackTypographySnapshot | null): string {
  return snapshot?.renderedTitle || track?.title || 'Somewhere on the dial';
}

function bridgeAlbum(track: TrackBridgeTrack): string {
  if (!track) return 'live broadcast';
  return [track.album, track.year].filter(Boolean).join(' · ') || 'live broadcast';
}

type TrackFacts = {
  bpm: string | null;
  musicalKey: string | null;
  genres: string[];
  tooltip: string;
};

function prioritizedTrackFacts(t: {
  genre?: string | null;
  bpm?: number | null;
  musicalKey?: string | null;
} | null): TrackFacts {
  if (!t) return { bpm: null, musicalKey: null, genres: [], tooltip: '' };

  // Genre source order is already a relevance signal from enrichment. Keep it,
  // dedupe it, and let the visual clamp discard the long tail. Tempo and key
  // are separate high-priority facts and always render before taxonomy.
  const seen = new Set<string>();
  const genres = (t.genre ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .filter(value => {
      const key = value.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(value => value.toUpperCase());
  const bpm = typeof t.bpm === 'number' && t.bpm > 0 ? `${Math.round(t.bpm)} BPM` : null;
  const musicalKey = t.musicalKey?.trim() ? t.musicalKey.trim().toUpperCase() : null;
  const tooltip = [bpm, musicalKey, ...genres].filter(Boolean).join(' · ');
  return { bpm, musicalKey, genres, tooltip };
}

function NerdIcon({ children }: { children: string }) {
  return <span className={styles.nerdIcon} aria-hidden="true">{children}</span>;
}

// Inline icon, intentionally independent of the aggressively subsetted 3270 Nerd Font.
function LyricsIcon() {
  return (
    <svg className={styles.lyricsIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true" focusable="false">
      <path d="M6 3.5h9l3 3V20.5H6z" />
      <path d="M15 3.5v3h3M9 10h6M9 13.5h6M9 17h4" />
    </svg>
  );
}

function SectionTag({ children, hero = false }: { children: string; hero?: boolean }) {
  return <div className={`${styles.liveLabel} ${styles.metaTag}`} data-hero-live={hero ? true : undefined}>{children}</div>;
}

function SelectingLabel() {
  const [dots, setDots] = useState(1);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDots(3);
      return;
    }
    const id = window.setInterval(() => setDots(value => value % 3 + 1), 520);
    return () => window.clearInterval(id);
  }, []);
  return <>selecting{'.'.repeat(dots)}</>;
}

function AirArtwork({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return null;
  return (
    <figure className={styles.airArtwork}>
      <img src={src} alt={alt} loading="lazy" decoding="async" fetchPriority="low" onError={() => setFailed(true)} />
    </figure>
  );
}

function AdaptiveTrackTitle({
  title,
  artist,
  album,
  stageRef,
  hasCover,
  onLayoutSettled,
  layoutRevision,
  preparedFit,
}: {
  title: string;
  artist: string;
  album: string;
  stageRef: RefObject<HTMLDivElement | null>;
  hasCover: boolean;
  onLayoutSettled?: (layoutRevision: number) => void;
  layoutRevision?: number;
  preparedFit?: PreparedTrackFit | null;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const titleNodeRef = useRef<HTMLHeadingElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [renderedTitle, setRenderedTitle] = useState(title);
  const [fontSize, setFontSize] = useState<number | null>(null);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const titleNode = titleNodeRef.current;
    const measure = measureRef.current;
    // Ancestor host refs can attach after child layout effects on first mount.
    // Resolve the already-mounted ancestor so the first title is fitted too.
    const stage = stageRef.current ?? shell?.closest<HTMLDivElement>('[data-track-fit-stage]');
    if (!shell || !titleNode || !measure || !stage) return;

    let rafA = 0;
    let rafB = 0;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let lateSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let layoutSettledTimer: ReturnType<typeof setTimeout> | null = null;
    let revision = 0;
    const cjk = hasCjk(title);

    const solveNow = () => {
      const stageWidth = stage.clientWidth;
      // Never fit against an overflowing stage's own growing height: that
      // rewards an oversized title with an ever-larger fitting budget.
      const stageHeight = stage.closest<HTMLElement>('[data-player-scrollport]')?.clientHeight ?? stage.clientHeight;
      if (stageWidth <= 0 || stageHeight <= 0) return;

      const stageStyle = getComputedStyle(stage);

      // v19 makes the preferred former 60%-browser-zoom composition the
      // native 100% layout: the radio now uses the same ~790px content clamp as
      // Home. Do not compensate for browser DPR/zoom here; normal browser zoom
      // should zoom the whole interface normally. The fitter owns only the three
      // track typography levels (title, artist, album/year).
      const designStageWidth = stageWidth;
      const designStageHeight = stageHeight;

      // Start from a deliberately generous upper bound and find the largest *complete hero*
      // that fits. There is no remembered preferred size and no line-count
      // heuristic, so returning to a previous zoom level converges to the same
      // geometry instead of to a prior equilibrium.
      const compactPortrait = window.matchMedia('(orientation: portrait) and (max-width: 760px)').matches;
      const minimum = compactPortrait ? (cjk ? 28 : 30) : (cjk ? 36 : 40);
      // Keep the hero emphatic without allowing short/stacked titles to turn
      // into viewport-filling billboard type. The previous 22vw/30vh ceiling
      // could reach ~170px in the normal clamp and overwhelmed the composition.
      const maximum = Math.max(
        minimum,
        Math.min(
          designStageWidth * (compactPortrait ? 0.16 : 0.18),
          designStageHeight * (compactPortrait ? 0.10 : 0.24),
          compactPortrait ? 56 : (cjk ? 136 : 152),
        ),
      );

      const portraitLayout = window.matchMedia('(orientation: portrait)').matches;
      const coverSizeFor = (titleSize: number) => {
        if (!hasCover) return 0;
        // Keep artwork visually substantial even for short titles. Above that
        // floor it follows the title by φ, then clamps like an Adw.Clamp child:
        // the plate stops growing and additional viewport width becomes air.
        // The hero fitter must shrink typography—not the artwork—to preserve
        // the title/art breathing room when horizontal space gets tight.
        const golden = titleSize * PHI;
        const floor = portraitLayout ? 132 : 140;
        const geometricCap = portraitLayout
          ? designStageWidth / PHI
          : designStageWidth / (PHI2 * PHI);
        const hardCap = portraitLayout ? 176 : 190;
        return clampNumber(golden, floor, Math.max(floor, Math.min(hardCap, geometricCap)));
      };

      const artGapFor = (titleSize: number) => {
        if (!hasCover) return 0;
        // One φ² step below the title provides a visible optical gutter without
        // becoming a second column of empty space. It scales with the title, so
        // the fitter naturally reduces typography before sacrificing the plate.
        return clampNumber(titleSize / PHI2, 18, 46);
      };

      const scaleFor = (titleSize: number) => ({
        artistSize: clampNumber(titleSize / PHI2, 24, 72),
        // Supporting musical identity stays readable above ancillary system
        // copy, without growing its spacing with a large hero title.
        albumSize: clampNumber(titleSize / PHI4, 16, 18),
        coverSize: coverSizeFor(titleSize),
      });

      const setTypeScale = (titleSize: number) => {
        const scale = scaleFor(titleSize);
        stage.style.setProperty('--sx-title-size', `${titleSize}px`);
        stage.style.setProperty('--sx-artist-size', `${scale.artistSize}px`);
        stage.style.setProperty('--sx-album-size', `${scale.albumSize}px`);
        stage.style.setProperty('--sx-cover-size', `${scale.coverSize}px`);
        stage.style.setProperty('--sx-art-gap', `${artGapFor(titleSize)}px`);
      };

      const setClusterWidth = (_text: string, _size: number) => {
        // One full-width clamp on landscape: the copy flexes, artwork is always
        // pinned to the stage's right edge, and the explicit art gap is part of
        // the fit budget. Portrait remains a single-column reading stack.
        stage.style.setProperty('--sx-copy-target', `${stageWidth}px`);
        stage.style.setProperty('--sx-cluster-width', `${stageWidth}px`);
      };

      const opticalCanvas = document.createElement('canvas');
      const opticalContext = opticalCanvas.getContext('2d');
      const opticalInset = (text: string, px: number, family: string) => {
        const first = Array.from(text.trimStart())[0];
        if (!first || px <= 0 || !opticalContext) return 0;
        opticalContext.textAlign = 'left';
        opticalContext.font = `400 ${px}px ${family}`;
        const metrics = opticalContext.measureText(first);
        const inset = Number.isFinite(metrics.actualBoundingBoxLeft)
          ? metrics.actualBoundingBoxLeft
          : 0;
        return clampNumber(Math.max(0, inset), 0, px * 0.09);
      };

      const setOpticalInsets = (text: string, titleSize: number) => {
        const scale = scaleFor(titleSize);
        const titlePx = titleSize;
        const artistPx = scale.artistSize;
        const albumPx = scale.albumSize;
        const dieFamily = `'SX Die Grotesk', 'Helvetica Neue', Arial, sans-serif`;
        const cjkFamily = `'Noto Sans CJK JP', 'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', system-ui, sans-serif`;
        stage.style.setProperty(
          '--sx-title-optical-inset',
          `${opticalInset(text, titlePx, cjk ? cjkFamily : dieFamily)}px`,
        );
        stage.style.setProperty('--sx-artist-optical-inset', `${opticalInset(artist, artistPx, dieFamily)}px`);
        stage.style.setProperty('--sx-album-optical-inset', `${opticalInset(album, albumPx, dieFamily)}px`);
      };

      const rectHeight = (selector: string) => {
        const node = stage.querySelector<HTMLElement>(selector);
        return node?.getBoundingClientRect().height ?? 0;
      };

      const applyCandidate = (text: string, size: number) => {
        setTypeScale(size);
        setClusterWidth(text, size);
        setOpticalInsets(text, size);
        titleNode.textContent = text;
        titleNode.style.fontSize = `${size}px`;
        // Resolve the linked typography, artwork, optical edge compensation and
        // full-width clamp before evaluating the complete hero candidate.
        void stage.offsetHeight;
      };

      const fitsCandidate = (text: string, size: number) => {
        applyCandidate(text, size);

        const header = rectHeight('[data-hero-header]');
        // The shared corridor fills its grid cell in BOTH views. Fit the
        // natural identity, never that allocated cell or the hidden transcript.
        const naturalCopy = rectHeight('[data-hero-copy]');
        const naturalCover = rectHeight('[data-artwork-surface] > figure');
        const artworkSurface = stage.querySelector<HTMLElement>('[data-artwork-surface]');
        const artRowGap = artworkSurface ? (parseFloat(getComputedStyle(artworkSurface).rowGap) || 0) : 0;
        const identityGap = parseFloat(stageStyle.getPropertyValue('--sx-label-gap')) || 12;
        const now = rectHeight('[data-hero-heading]') + identityGap + (portraitLayout
          ? naturalCopy + naturalCover + (hasCover ? artRowGap : 0) : Math.max(naturalCopy, naturalCover));
        const controls = rectHeight('[data-hero-controls]');
        const outerHeight = (selector: string) => {
          const node = stage.querySelector<HTMLElement>(selector);
          if (!node) return 0;
          const style = getComputedStyle(node);
          const marginTop = Number.parseFloat(style.marginTop) || 0;
          const marginBottom = Number.parseFloat(style.marginBottom) || 0;
          return node.getBoundingClientRect().height + marginTop + marginBottom;
        };
        const main = now + outerHeight('[data-hero-progress]') + outerHeight('[data-hero-facts]');

        // Fit against the natural hero contents, not the animated track corridor.
        // During a handoff that corridor intentionally holds max(old,new) height;
        // measuring it here creates a feedback loop where no font size can make
        // the fixed min-height smaller, so the fitter incorrectly falls through
        // to an ellipsis at handback.
        const springReserve = (parseFloat(stageStyle.paddingTop) || 0)
          + (parseFloat(stageStyle.paddingBottom) || 0)
          + (parseFloat(stageStyle.getPropertyValue('--sx-station-song-gap')) || 26)
          + (parseFloat(stageStyle.getPropertyValue('--sx-playback-controls-gap')) || 26);
        const verticalFits = header + main + controls + springReserve <= stageHeight + 1;
        const horizontalFits = Math.max(shell.scrollWidth, titleNode.scrollWidth) <= shell.clientWidth + 1;
        return verticalFits && horizontalFits;
      };

      let resultText = title;
      let resultSize = minimum;

      if (fitsCandidate(title, maximum)) {
        resultSize = maximum;
      } else if (fitsCandidate(title, minimum)) {
        let low = minimum;
        let high = maximum;
        for (let index = 0; index < 15; index += 1) {
          const mid = (low + high) / 2;
          if (fitsCandidate(title, mid)) low = mid;
          else high = mid;
        }
        resultSize = low;
      } else {
        // Truncation remains the absolute last resort after the complete linked
        // hierarchy has reached its minimum scale. The real candidate is
        // measured, so the ellipsis is deterministic for this viewport.
        const glyphs = Array.from(title);
        let low = 1;
        let high = glyphs.length;
        let best = '…';
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const stem = glyphs.slice(0, mid).join('').trimEnd();
          const candidate = `${stem}…`;
          if (fitsCandidate(candidate, minimum)) {
            best = candidate;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }
        resultText = best;
        resultSize = minimum;
      }

      applyCandidate(resultText, resultSize);
      const rounded = Math.round(resultSize * 10) / 10;
      setRenderedTitle(previous => previous === resultText ? previous : resultText);
      setFontSize(previous => previous === rounded ? previous : rounded);
    };

    const queue = () => {
      revision += 1;
      const current = revision;
      if (rafA) cancelAnimationFrame(rafA);
      if (rafB) cancelAnimationFrame(rafB);
      if (settleTimer) clearTimeout(settleTimer);
      if (lateSettleTimer) clearTimeout(lateSettleTimer);
      if (layoutSettledTimer) clearTimeout(layoutSettledTimer);

      // Two frames let Firefox finish recalculating CSS viewport dimensions
      // after browser-zoom changes before we solve against the new geometry.
      rafA = requestAnimationFrame(() => {
        rafB = requestAnimationFrame(() => {
          if (current === revision) solveNow();
        });
      });

      // A final idempotent settle pass catches late visualViewport/font layout
      // updates without depending on the previous solution.
      settleTimer = setTimeout(() => {
        if (current === revision) solveNow();
      }, 120);
      lateSettleTimer = setTimeout(() => {
        if (current === revision) solveNow();
      }, 320);
      layoutSettledTimer = setTimeout(() => {
        if (current === revision) onLayoutSettled?.(layoutRevision ?? 0);
      }, 360);
    };

    // The bridge already painted this geometry. Do not recompute a different
    // live optimum at handback: carry the exact probe snapshot into the real
    // title, and only re-solve on an actual viewport/font geometry change.
    const canAdopt = preparedFit
      && preparedFit.title === title
      && preparedFit.artist === artist
      && preparedFit.album === album
      && preparedFit.hasCover === hasCover
      && Math.abs(preparedFit.stageWidth - stage.clientWidth) <= 1
      && Math.abs(preparedFit.stageHeight - stage.clientHeight) <= 1
      && Number.parseFloat(preparedFit.typography.titleSize) > 0;
    let adopted = false;
    if (canAdopt) {
      const typography = preparedFit.typography;
      const variables = {
        '--sx-title-size': typography.titleSize,
        '--sx-artist-size': typography.artistSize,
        '--sx-album-size': typography.albumSize,
        '--sx-cover-size': typography.coverSize,
        '--sx-art-gap': typography.artGap,
        '--sx-title-optical-inset': typography.titleOpticalInset,
        '--sx-artist-optical-inset': typography.artistOpticalInset,
        '--sx-album-optical-inset': typography.albumOpticalInset,
        '--sx-copy-target': `${stage.clientWidth}px`,
        '--sx-cluster-width': `${stage.clientWidth}px`,
      };
      Object.entries(variables).forEach(([name, value]) => stage.style.setProperty(name, value));
      const fittedTitle = typography.renderedTitle || title;
      const fittedSize = Number.parseFloat(typography.titleSize);
      titleNode.textContent = fittedTitle;
      titleNode.style.fontSize = typography.titleSize;
      setRenderedTitle(previous => previous === fittedTitle ? previous : fittedTitle);
      setFontSize(previous => previous === fittedSize ? previous : fittedSize);
      adopted = true;
      // The layout effect commits the snapshot before paint. Report settled
      // without scheduling the old 120/320ms redundant fitting passes.
      layoutSettledTimer = setTimeout(() => onLayoutSettled?.(layoutRevision ?? 0), 0);
    } else {
      solveNow();
      queue();
    }

    let pendingViewResize = false;
    const onStageResize = () => {
      if (stage.closest('[data-sx-view-moving]')) {
        pendingViewResize = true;
        return;
      }
      if (adopted) {
        if (Math.abs((preparedFit?.stageWidth ?? 0) - stage.clientWidth) <= 1
          && Math.abs((preparedFit?.stageHeight ?? 0) - stage.clientHeight) <= 1) return;
        adopted = false;
      }
      queue();
    };
    const onViewSettled = () => {
      if (!pendingViewResize) return;
      pendingViewResize = false;
      onStageResize();
    };
    const onViewportResize = () => {
      adopted = false;
      queue();
    };
    const onFontChange = () => {
      adopted = false;
      queue();
    };
    const observer = new ResizeObserver(onStageResize);
    observer.observe(stage);
    stage.addEventListener('sxntax:presentation-settled', onViewSettled);
    // A font event or genuine viewport change still triggers a responsive fit.
    // A resolved document.fonts.ready promise must not undo an adopted handoff.
    void document.fonts?.ready.then(() => { if (!adopted) queue(); });
    document.fonts?.addEventListener?.('loadingdone', onFontChange);
    window.addEventListener('resize', onViewportResize, { passive: true });
    window.visualViewport?.addEventListener('resize', onViewportResize);

    return () => {
      observer.disconnect();
      stage.removeEventListener('sxntax:presentation-settled', onViewSettled);
      document.fonts?.removeEventListener?.('loadingdone', onFontChange);
      window.removeEventListener('resize', onViewportResize);
      window.visualViewport?.removeEventListener('resize', onViewportResize);
      if (rafA) cancelAnimationFrame(rafA);
      if (rafB) cancelAnimationFrame(rafB);
      if (settleTimer) clearTimeout(settleTimer);
      if (lateSettleTimer) clearTimeout(lateSettleTimer);
      if (layoutSettledTimer) clearTimeout(layoutSettledTimer);
    };
  }, [title, artist, album, hasCover, stageRef, layoutRevision, preparedFit]);

  return (
    <div ref={shellRef} className={styles.titleShell}>
      <h1
        ref={titleNodeRef}
        className={`${styles.titleNormal} ${hasCjk(title) ? styles.titleCjk : ''}`}
        style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
        data-phosphor-text={renderedTitle}
      >
        {renderedTitle}
      </h1>
      <div
        ref={measureRef}
        className={`${styles.titleMeasure} ${hasCjk(title) ? styles.titleCjk : ''}`}
        aria-hidden="true"
      />
    </div>
  );
}

const SXNTAX_SKIN_REVISION = 'p21-3-elastic-reconcile';

export default function SxntaxSkin({ contained }: SkinProps) {
  const client = useStationClient();
  const {
    nowPlaying, context, dj, activeShow, listeners, state, session, stream, streamOnline,
    trackStartedAt, trackPausedAt, stationClock, timezone, locale, reconciliationId,
  } = usePlayerFeed();
  const {
    audioRef, audioElement, tunedIn, volume, muted, offline, signal,
  } = usePlayerAudio();
  const { toggleMute } = usePlayerActions();
  const { showOverlay, tuneInFromOverlay, handleTune } = useTuneInGate();
  const { lite, setLite } = useLiteMode();
  const [presentedTrack, setPresentedTrack] = useState(nowPlaying);
  const presentedTrackRef = useRef(presentedTrack);
  const incomingTrackRef = useRef(nowPlaying);
  const presentedTrackKeyRef = useRef(trackIdentity(nowPlaying));
  const liveLayoutSettledKeyRef = useRef(trackIdentity(nowPlaying));
  const expectedLiveLayoutRevisionRef = useRef(0);
  const handoffCoverSizeRef = useRef<{ from: number; to: number } | null>(null);
  const [presentationPhase, setPresentationPhase] = useState<TrackPresentationPhase>('stable');
  const [handoffPresentation, setHandoffPresentation] = useState<TrackHandoffPresentation | null>(null);
  const [rendererMode, setRendererMode] = useState<RendererMode>('shell');
  const [rendererStarting, setRendererStarting] = useState(false);
  const [gateReleasing, setGateReleasing] = useState(false);
  const [rendererReveal, setRendererReveal] = useState(false);
  const [manualGate, setManualGate] = useState(false);
  const [fullRequested, setFullRequested] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const [cssReady, setCssReady] = useState(false);
  const [feedReadyFallback, setFeedReadyFallback] = useState(false);
  const [bootReady, setBootReady] = useState(false);
  const [showBootGauge, setShowBootGauge] = useState(false);
  // User intent survives unavailable songs; actual visibility follows this song’s verified document.
  const [lyricsWanted, setLyricsWanted] = useState(false);
  const [lyricsPreview, setLyricsPreview] = useState<LyricsPreviewMode | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const transitionProgressRef = useRef(0);
  const handoffActiveRef = useRef(false);
  const handoffLeaseRef = useRef<ReturnType<typeof createHandoffLease> | null>(null);
  const reconciliationGateRef = useRef(createReconciliationGate());
  const lyricsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const lyricsFrameRequestedRef = useRef(false);
  const nowClusterRef = useRef<HTMLDivElement | null>(null);
  const [transitionTuning] = useState<TransitionTuning>(() => readTransitionTuning());

  // Visual QA fixtures are strictly development-only and never substitute
  // for actual Navidrome lyrics in production.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const mode = new URLSearchParams(window.location.search).get('lyricsDemo');
    if (mode === 'plain' || mode === 'line' || mode === 'word') setLyricsPreview(mode);
  }, []);

  const closeLyrics = useCallback(() => {
    setLyricsWanted(false);
    requestAnimationFrame(() => lyricsTriggerRef.current?.focus());
  }, []);

  const elapsed = useElapsed(trackStartedAt, trackPausedAt, stationClock);
  // Prefetch the AIRING recording, not the delayed outgoing identity. The
  // track handoff remains the sole authority for when incoming text may paint.
  const lyricsSongId = nowPlaying?.subsonic_id ?? null;
  // Availability is resolved before the listener opens Lyrics, so an empty
  // Navidrome record disables the control instead of opening an empty view.
  const liveLyrics = useCurrentLyrics(client, lyricsSongId, Boolean(lyricsSongId) && !offline && !lyricsPreview, tunedIn);
  const lyricsAvailable = canShowLyrics(liveLyrics.status, liveLyrics.document, Boolean(lyricsPreview));
  const lyricsOpen = shouldShowRequestedLyrics(lyricsWanted, liveLyrics.status, liveLyrics.document, Boolean(lyricsPreview), offline);
  // Loading/error is a neutral lyric scene, never a claim of confirmed absence.
  const lyricsSceneRequested = shouldKeepLyricsScene(lyricsWanted, liveLyrics.status, Boolean(lyricsPreview), offline);
  const presentedMatchesAiring = trackIdentity(presentedTrack) === trackIdentity(nowPlaying);
  const lyricDocumentKey = presentedMatchesAiring ? liveLyrics.document?.id ?? null : null;
  const { phase: lyricsViewPhase, mounted: lyricsSurfaceActive, setTrackHeight } = useLyricsPresentation(
    rootRef, lyricsSceneRequested, lyricDocumentKey, lite, transitionProgressRef, handoffActiveRef, bootReady,
  );


  useEffect(() => {
    // A fallback is not a user action. Restore Lyrics automatically when the
    // next eligible song arrives, but never display a stale document while loading.
    if (lyricsWanted && !lyricsOpen && typeof document !== 'undefined') {
      const focused = document.activeElement;
      if (focused instanceof Element && focused.closest('[data-lyrics-perspective]')) {
        requestAnimationFrame(() => nowClusterRef.current?.focus({ preventScroll: true }));
      }
    }
  }, [lyricsWanted, lyricsOpen]);
  // On a stale startedAt the displayed elapsed clock can exceed the track's
  // actual duration by hours. Never use that to jump into the final lyric.
  const currentAiringLyricMs = tunedIn && !offline && streamOnline !== false && trackStartedAt !== null
    ? safeLyricsPositionMs(elapsed, presentedTrack?.duration ?? null) : null;
  // The station's clock switches to incoming audio BEFORE the outgoing title
  // finishes its handoff. Never drive the outgoing lyric renderer with the new
  // song's near-zero position: that was a separate source of the top-of-song jump.
  const [lastPresentedLyricPosition, setLastPresentedLyricPosition] = useState<{key: string; ms: number | null}>({key: '', ms: null});
  useEffect(() => {
    if (presentedMatchesAiring && currentAiringLyricMs !== null) {
      const key = trackIdentity(presentedTrack);
      setLastPresentedLyricPosition(previous => previous.key === key && previous.ms === currentAiringLyricMs
        ? previous : {key, ms: currentAiringLyricMs});
    }
  }, [presentedMatchesAiring, currentAiringLyricMs, presentedTrack]);
  const lyricsEstimatedMs = presentedLyricPosition(
    trackIdentity(presentedTrack), trackIdentity(nowPlaying), currentAiringLyricMs, lastPresentedLyricPosition,
  );
  const clock = useClock();
  const stationLocale = normalizeStationLocale(locale);
  const { stationName, djName, showName } = stationIdentity(dj, activeShow, context);
  const listenerCount = listenerCountOf(listeners);
  const ratio = progressRatio(elapsed, presentedTrack?.duration);
  const trackFacts = useMemo(() => prioritizedTrackFacts(presentedTrack), [presentedTrack]);
  const incomingTrackFacts = useMemo(() => prioritizedTrackFacts(nowPlaying), [nowPlaying]);
  const air = useMemo(() => buildAirHistory({
    state,
    nowPlaying,
    messages: session.messages,
    leadMs: Math.min(60, Math.max(0, stream?.bufferSeconds ?? 0)) * 1000,
    nowMs: stationClock.nowMs() ?? clock?.getTime() ?? Date.now(),
  }), [state, nowPlaying, session.messages, stream?.bufferSeconds, clock, stationClock]);
  const upNext = air.next;

  const like = useTrackLike();
  const adjustVolume = useVolumeNudge();
  const scheduleTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const scheduleId = useId();
  const transitionIntensityRef = useRef(0);
  const requestRef = useRef<HTMLTextAreaElement | null>(null);
  const requestSectionRef = useRef<HTMLElement | null>(null);
  const airSectionRef = useRef<HTMLElement | null>(null);
  const scrollportRef = useRef<HTMLDivElement | null>(null);
  const heroStageRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    // Only an explicit Lyrics open may move the outer page. Never reframe on
    // clock ticks, song handoffs, missing documents or background updates.
    if (!lyricsOpen || !lyricsSurfaceActive || !lyricsFrameRequestedRef.current) return;
    // Wait one animation frame for the nested transcript to establish its
    // initial (instant) follow position. Measuring synchronously here used an
    // outdated line rectangle, then scrolled the entire hero too far.
    const raf = requestAnimationFrame(() => {
      lyricsFrameRequestedRef.current = false;
      const outer = scrollportRef.current;
      const stage = heroStageRef.current;
      const region = stage?.querySelector<HTMLElement>('[data-lyrics-scroll]');
      if (!outer || !stage || !region) return;
      const outerRect = outer.getBoundingClientRect();
      const heroRect = stage.getBoundingClientRect();
      const top = lyricsOpeningScrollTop({
        outerTop: outerRect.top,
        outerHeight: outer.clientHeight,
        outerScrollTop: outer.scrollTop,
        heroTop: heroRect.top,
        heroHeight: heroRect.height,
      });
      outer.scrollTo({ top, behavior: 'instant' });
    });
    return () => cancelAnimationFrame(raf);
  }, [lyricsOpen, lyricsSurfaceActive]);

  const geometryProbeStageRef = useRef<HTMLDivElement | null>(null);
  const geometryProbeNowRef = useRef<HTMLDivElement | null>(null);
  const incomingGeometryRef = useRef<{
    key: string;
    height: number;
    fit: PreparedTrackFit | null;
  } | null>(null);
  const cssReadyProbeRef = useRef<HTMLSpanElement | null>(null);
  const [trackCorridorHeight, setTrackCorridorHeight] = useState<number | null>(null);
  const [trackLayoutRevision, setTrackLayoutRevision] = useState(0);
  const [preparedTrackFit, setPreparedTrackFit] = useState<PreparedTrackFit | null>(null);
  const [requestHint, setRequestHint] = useState('');
  const [requestHintSeen, setRequestHintSeen] = useState(false);
  const slip = useRequestSlip({
    sent: 'Request received — the booth has it.',
    refused: 'The booth passed on this one.',
    failed: 'The booth line is down — try again.',
  });

  const incomingTrackKey = trackIdentity(nowPlaying);

  useEffect(() => {
    incomingTrackRef.current = nowPlaying;
  }, [nowPlaying]);

  useEffect(() => {
    presentedTrackRef.current = presentedTrack;
  }, [presentedTrack]);

  // Never expose the font-swap / half-fed startup state. The cheap shell (frame
  // + clock) can paint immediately; player content and the tune gate only reveal
  // once the two SXNTAX faces are actually available and the first station poll
  // has had a chance to land.
  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      if (!cancelled) setFontsReady(true);
    }, 2500);

    const load = async () => {
      try {
        if (document.fonts) {
          // Both SXNTAX faces are presentation-critical. 3270 is now a tiny
          // source-generated WOFF2 subset rather than the 2.75 MB Nerd Font, so
          // waiting for it protects icon/system-copy geometry without bloating
          // the critical path.
          await Promise.all([
            document.fonts.load('64px "SX Die Grotesk"'),
            document.fonts.load('18px "SX 3270"'),
          ]);
        }
      } catch {
        // Local font loss uses the declared fallback stack and its measured
        // geometry; it must not leak an unhandled font-load rejection.
      } finally {
        if (!cancelled) setFontsReady(true);
        window.clearTimeout(timeout);
      }
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const probe = () => {
      if (cancelled) return;
      const node = cssReadyProbeRef.current;
      if (node && getComputedStyle(node).getPropertyValue('--sx-css-ready').trim() === '1') {
        setCssReady(true);
        return;
      }
      raf = requestAnimationFrame(probe);
    };
    raf = requestAnimationFrame(probe);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setFeedReadyFallback(true), 1400);
    return () => window.clearTimeout(timeout);
  }, []);

  const firstFeedReady = streamOnline !== null || nowPlaying !== null || feedReadyFallback;

  // Warm the first artwork request as soon as the feed identifies it, but do
  // not make image decode a prerequisite for revealing the player. The hero
  // can paint immediately and the image element/Kawarp consume the warmed HTTP
  // cache when they become visible.
  useEffect(() => {
    if (!firstFeedReady || !nowPlaying?.subsonic_id) return;
    let cancelled = false;
    const image = new Image();
    image.decoding = 'async';
    image.src = client.coverUrl(nowPlaying.subsonic_id);
    if (typeof image.decode === 'function') {
      void image.decode().catch(() => {}).finally(() => {
        if (cancelled) image.src = '';
      });
    }
    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [client, firstFeedReady, nowPlaying?.subsonic_id]);

  // v30 splits startup into two readiness boundaries. UI readiness owns the
  // first impression: once CSS + the geometry-critical display face are ready, the Tune In
  // gate appears atomically. Player readiness continues in parallel and only
  // controls whether the completed hero may be revealed / the renderer gate
  // may be released. This avoids both FOUT and a long blank wait for cover/feed.
  const uiReady = cssReady && fontsReady;
  const playerReady = bootReady;
  const bootProgress = [cssReady, fontsReady].filter(Boolean).length / 2;

  useEffect(() => {
    if (uiReady && firstFeedReady) setBootReady(true);
  }, [firstFeedReady, uiReady]);

  useEffect(() => {
    if (uiReady) return;
    const id = window.setTimeout(() => setShowBootGauge(true), 180);
    return () => window.clearTimeout(id);
  }, [uiReady]);

  useEffect(() => {
    if (uiReady) setShowBootGauge(false);
  }, [uiReady]);

  // Observe the independent incoming-track probe, never the live corridor.
  // The probe owns content-fit geometry; its output is applied one-way to the
  // normal scene. Lyrics uses the CSS grid's remaining-height track directly.
  useLayoutEffect(() => {
    const node = geometryProbeNowRef.current;
    if (!node) return;
    const key = incomingTrackKey;
    let rafA = 0;
    let rafB = 0;
    let revision = 0;
    let disposed = false;

    const measure = () => {
      revision += 1;
      const currentRevision = revision;
      if (rafA) cancelAnimationFrame(rafA);
      if (rafB) cancelAnimationFrame(rafB);
      rafA = requestAnimationFrame(() => {
        rafB = requestAnimationFrame(() => {
          if (disposed || currentRevision !== revision || trackIdentity(nowPlaying) !== key) return;
          const geometry = measureTrackGeometry(key, nowPlaying, geometryProbeStageRef.current, node);
          if (!geometry) return;
          incomingGeometryRef.current = geometry;
          if (lyricsViewPhase === 'artwork' && presentationPhase === 'stable') {
            setTrackCorridorHeight(previous => previous === geometry.height ? previous : geometry.height);
          }
        });
      });
    };

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => {
      disposed = true;
      revision += 1;
      observer.disconnect();
      if (rafA) cancelAnimationFrame(rafA);
      if (rafB) cancelAnimationFrame(rafB);
    };
  }, [incomingTrackKey, lyricsViewPhase, nowPlaying, presentationPhase]);

  const awaitIncomingGeometry = useCallback(async (key: string, timeoutMs = 700) => {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      const geometry = incomingGeometryRef.current;
      if (geometry?.key === key && geometry.height > 0) return geometry;
      await new Promise<void>(resolve => window.setTimeout(resolve, 32));
    }
    return null;
  }, []);

  const applyTransitionVisualState = useCallback((progress: number) => {
    const p = clampNumber(progress, 0, 1);
    const raw = Math.max(0, Math.sin(Math.PI * p));
    const luminosity = Math.pow(raw, Math.max(2.6, transitionTuning.peakExponent * 0.46));
    const instability = Math.pow(raw, transitionTuning.peakExponent);
    const root = rootRef.current;

    transitionProgressRef.current = p;
    transitionIntensityRef.current = instability;
    if (!root) return;

    // v38: the mass layers are deliberately short-lived paint-only traces.
    // Outgoing mass is an afterimage; incoming mass is a beforeimage. Both are
    // substantially quieter than v37 and overlap only around the crossover.
    // The crisp layers keep the resting phosphor vocabulary in CSS so there is
    // no flat/unlit middle step as the bridge hands back to normal playback.
    // They remain geometrically sharp: all defocus lives in the extra mass
    // layers, leaving the glyph interior available to the CRT/noise texture.
    const outgoingCore = 1 - smoothstep01((p - 0.06) / 0.30);
    const incomingCore = smoothstep01((p - 0.48) / 0.26);
    const outgoingAfterimage = smoothstep01((p - 0.02) / 0.18)
      * (1 - smoothstep01((p - 0.36) / 0.20));
    const incomingBeforeimage = smoothstep01((p - 0.16) / 0.18)
      * (1 - smoothstep01((p - 0.50) / 0.22));
    const bridgeMassBlur = 2 + luminosity * transitionTuning.massBlur;
    const traceOpacity = 0.48;

    // Artwork follows the shorter identity handoff while Kawarp/ambient keeps
    // its independent ten-second transition. The frame itself never changes.
    const incomingCover = smoothstep01((p - 0.08) / 0.56);
    const outgoingCover = 1 - incomingCover;

    root.style.setProperty('--sx-transition-intensity', instability.toFixed(4));
    root.style.setProperty('--sx-transition-luminosity', luminosity.toFixed(4));
    root.style.setProperty('--sx-bridge-out-core', outgoingCore.toFixed(4));
    root.style.setProperty('--sx-bridge-in-core', incomingCore.toFixed(4));
    root.style.setProperty('--sx-bridge-out-mass', clampNumber(outgoingAfterimage * traceOpacity, 0, 1).toFixed(4));
    root.style.setProperty('--sx-bridge-in-mass', clampNumber(incomingBeforeimage * traceOpacity, 0, 1).toFixed(4));
    root.style.setProperty('--sx-bridge-mass-blur', `${bridgeMassBlur.toFixed(2)}px`);
    root.style.setProperty('--sx-cover-out-opacity', outgoingCover.toFixed(4));
    root.style.setProperty('--sx-cover-in-opacity', incomingCover.toFixed(4));
    const coverRange = handoffCoverSizeRef.current;
    if (coverRange) {
      const sizeProgress = smoothstep01(p);
      const coverSize = coverRange.from + (coverRange.to - coverRange.from) * sizeProgress;
      root.style.setProperty('--sx-handoff-cover-size', `${coverSize.toFixed(2)}px`);
    }
  }, [transitionTuning]);

  const resetTransitionVisualState = useCallback(() => {
    transitionProgressRef.current = 0;
    transitionIntensityRef.current = 0;
    handoffActiveRef.current = false;
    const root = rootRef.current;
    if (!root) return;
    [
      '--sx-transition-intensity',
      '--sx-transition-luminosity',
      '--sx-bridge-out-core',
      '--sx-bridge-in-core',
      '--sx-bridge-out-mass',
      '--sx-bridge-in-mass',
      '--sx-bridge-mass-blur',
      '--sx-cover-out-opacity',
      '--sx-cover-in-opacity',
      '--sx-handoff-cover-size',
    ].forEach(name => root.style.removeProperty(name));
    handoffCoverSizeRef.current = null;
  }, []);

  const settleTrackHandoff = useCallback(() => {
    handoffActiveRef.current = false;
    setTrackHeight(null);
    const settled = settledTrackPresentation<TrackHandoffPresentation>();
    setPresentationPhase(settled.phase);
    setHandoffPresentation(settled.presentation);
  }, [setTrackHeight]);

  // A foreground reconciliation is not a witnessed transition. The feed has
  // already selected the listener-audible identity, so cancel any paused RAF
  // lease and settle all presentation ownership in the same React update.
  useEffect(() => {
    if (!nowPlaying || !reconciliationGateRef.current.consume(reconciliationId)) return;
    handoffLeaseRef.current?.cancel();
    handoffLeaseRef.current = null;
    presentedTrackKeyRef.current = trackIdentity(nowPlaying);
    setPreparedTrackFit(null);
    setTrackCorridorHeight(null);
    setPresentedTrack(nowPlaying);
    settleTrackHandoff();
    resetTransitionVisualState();
  }, [nowPlaying, reconciliationId, resetTransitionVisualState, settleTrackHandoff]);

  // CSS hides the live copy while the handoff class is active, and the bridge
  // opacity/cover variables live on the root. Clear those variables only after
  // the stable identity state has committed, so no paint can combine a hidden
  // live copy with the bridge's fallback opacity and outgoing-cover defaults.
  useLayoutEffect(() => {
    if (!shouldResetTrackHandoffStyles(presentationPhase, handoffPresentation)) return;
    resetTransitionVisualState();
  }, [handoffPresentation, presentationPhase, resetTransitionVisualState]);

  // The song identity runs on a shorter golden-ratio handoff while Kawarp and
  // the ambient base keep their ten-second transition independently.
  // Layout safety is solved by an early max(old,new) track corridor expansion in
  // normal document flow; no section-level FLIP transforms participate. The string
  // swap happens at crossover, and the corridor may release before paint-only
  // afterimages finish so they cannot hold the surrounding sections in place.
  useEffect(() => {
    const incomingTrack = incomingTrackRef.current;
    if (!playerReady || !tunedIn || !presentedTrackRef.current?.title || !incomingTrack?.title) {
      presentedTrackKeyRef.current = incomingTrackKey;
      setPresentedTrack(incomingTrack);
      settleTrackHandoff();
      return;
    }

    if (incomingTrackKey === presentedTrackKeyRef.current) return;

    const lease = createHandoffLease();
    handoffLeaseRef.current = lease;
    let frame = 0;
    let swapped = false;
    let liveFitRequested = false;
    let geometryReserved = false;
    const timers: number[] = [];
    const wait = (ms: number) => new Promise<void>(resolve => {
      const id = window.setTimeout(resolve, ms);
      timers.push(id);
    });

    const prepareCover = async () => {
      if (!incomingTrack?.subsonic_id) return;
      const src = client.coverUrl(incomingTrack.subsonic_id);
      const image = new Image();
      image.decoding = 'async';
      image.src = src;
      try {
        await Promise.race([
          typeof image.decode === 'function' ? image.decode() : new Promise<void>(resolve => {
            image.onload = () => resolve();
            image.onerror = () => resolve();
          }),
          wait(650),
        ]);
      } catch {
        // Decode failures should not block metadata presentation.
      }
    };

    const run = async () => {
      await prepareCover();
      if (!lease.isCurrent()) return;
      if (lite) {
        presentedTrackKeyRef.current = incomingTrackKey;
        setPresentedTrack(incomingTrack);
        settleTrackHandoff();
        return;
      }

      const incomingGeometry = await awaitIncomingGeometry(incomingTrackKey);
      if (!lease.isCurrent()) return;
      const incomingHeight = incomingGeometry?.height ?? null;
      setPreparedTrackFit(incomingGeometry?.fit ?? null);
      const outgoingHeight = trackCorridorHeight ?? nowClusterRef.current?.getBoundingClientRect().height ?? 0;
      const growing = incomingHeight != null && incomingHeight > outgoingHeight + 1;
      const shrinking = incomingHeight != null && incomingHeight < outgoingHeight - 1;
      const safeHeight = Math.max(outgoingHeight, incomingHeight ?? 0);

      if (safeHeight > 0) setTrackCorridorHeight(safeHeight);
      // Layout remains bounded by the stage for every track. Typography, art,
      // and identity still use the full existing phosphor handoff choreography.
      const outgoingTypography = readTrackTypography(heroStageRef.current);
      const incomingTypography = incomingGeometry?.fit?.typography ?? outgoingTypography;
      const outgoingCoverSize = Number.parseFloat(outgoingTypography?.coverSize ?? '');
      const incomingCoverSize = Number.parseFloat(incomingTypography?.coverSize ?? '');
      if (Number.isFinite(outgoingCoverSize) || Number.isFinite(incomingCoverSize)) {
        const from = Number.isFinite(outgoingCoverSize) ? outgoingCoverSize : incomingCoverSize;
        const to = Number.isFinite(incomingCoverSize) ? incomingCoverSize : outgoingCoverSize;
        handoffCoverSizeRef.current = {
          from: Number.isFinite(from) ? from : 0,
          to: Number.isFinite(to) ? to : 0,
        };
      } else {
        handoffCoverSizeRef.current = null;
      }
      setHandoffPresentation({
        outgoing: presentedTrackRef.current,
        incoming: incomingTrack,
        outgoingTypography,
        incomingTypography,
      });
      handoffActiveRef.current = true;
      setPresentationPhase('decay');

      const startedAt = performance.now();
      const tick = (now: number) => {
        if (!lease.isCurrent()) return;
        if (!geometryReserved) {
          geometryReserved = true;
          // The handoff class has committed by this frame, so its established
          // CSS glide applies. Only the shared coordinator writes the height.
          if (safeHeight > 0) setTrackHeight(safeHeight);
        }
        const progress = clampNumber((now - startedAt) / TRACK_HANDOFF_MS, 0, 1);
        applyTransitionVisualState(progress);

        // Shrinking (and essentially equal-height) identities may swap at the
        // visual crossover: the incoming live layout can then contract beneath
        // the bridge for the entire second half and finish with the phosphor.
        // Growing identities deliberately defer the semantic swap until p=1 so
        // their corridor can keep expanding for the whole handoff without the
        // larger live DOM forcing an early jump.
        if (!swapped && !growing && progress >= TRACK_SWAP_PROGRESS) {
          swapped = true;
          presentedTrackKeyRef.current = incomingTrackKey;
          setPresentedTrack(incomingTrack);
          setPresentationPhase('rewrite');
          if (shrinking && incomingHeight) {
            setTrackCorridorHeight(incomingHeight);
            setTrackHeight(incomingHeight);
          }
        }

        if (progress >= 1) {
          if (!swapped) {
            swapped = true;
            presentedTrackKeyRef.current = incomingTrackKey;
            setPresentedTrack(incomingTrack);
            setPresentationPhase('rewrite');
          }
          if (incomingHeight) {
            setTrackCorridorHeight(incomingHeight);
            setTrackHeight(incomingHeight);
          }
          // Request one explicit final solve only after the synchronized layout
          // window has completed. Keep the incoming bridge painted until that
          // revision reports settled, so the fitted live title can never resize
          // in view during handback.
          if (!liveFitRequested) {
            liveFitRequested = true;
            setTrackLayoutRevision(value => {
              const next = value + 1;
              expectedLiveLayoutRevisionRef.current = next;
              liveLayoutSettledKeyRef.current = `pending:${incomingTrackKey}@${next}`;
              return next;
            });
          }
          const liveSettled = liveLayoutSettledKeyRef.current === incomingTrackKey;
          if (!liveSettled && now - startedAt < TRACK_HANDOFF_MS + 900) {
            frame = requestAnimationFrame(tick);
            return;
          }
          handoffActiveRef.current = false;
          settleTrackHandoff();
          return;
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    void run();

    return () => {
      lease.cancel();
      if (handoffLeaseRef.current === lease) handoffLeaseRef.current = null;
      cancelAnimationFrame(frame);
      timers.forEach(id => window.clearTimeout(id));
      settleTrackHandoff();
    };
  }, [
    applyTransitionVisualState,
    awaitIncomingGeometry,
    client,
    incomingTrackKey,
    lite,
    playerReady,
    setTrackHeight,
    settleTrackHandoff,
    tunedIn,
  ]);

  // Same-track enrichment (genres/BPM/year arriving on a later poll) updates in
  // place without replaying the song-change transition.
  useEffect(() => {
    if (presentationPhase !== 'stable') return;
    if (incomingTrackKey !== presentedTrackKeyRef.current) return;
    setPresentedTrack(nowPlaying);
  }, [incomingTrackKey, nowPlaying, presentationPhase]);

  const gateReleaseTimerRef = useRef<number | null>(null);
  const revealTimerRef = useRef<number | null>(null);
  const queuedReleaseModeRef = useRef<Exclude<RendererMode, 'shell'> | null>(null);
  const commitRendererGate = useCallback((mode: Exclude<RendererMode, 'shell'>) => {
    queuedReleaseModeRef.current = null;
    setRendererMode(mode);
    setGateReleasing(true);
    setRendererReveal(mode === 'full');

    if (gateReleaseTimerRef.current != null) window.clearTimeout(gateReleaseTimerRef.current);
    if (revealTimerRef.current != null) window.clearTimeout(revealTimerRef.current);

    const releaseMs = mode === 'full' ? GATE_RELEASE_MS_FULL : GATE_RELEASE_MS_LITE;
    gateReleaseTimerRef.current = window.setTimeout(() => {
      gateReleaseTimerRef.current = null;
      setRendererStarting(false);
      setGateReleasing(false);
    }, releaseMs);

    if (mode === 'full') {
      revealTimerRef.current = window.setTimeout(() => {
        revealTimerRef.current = null;
        setRendererReveal(false);
      }, FULL_REVEAL_MS);
    }
  }, []);

  const releaseRendererGate = useCallback((mode: Exclude<RendererMode, 'shell'>) => {
    if (!playerReady) {
      queuedReleaseModeRef.current = mode;
      return;
    }
    commitRendererGate(mode);
  }, [commitRendererGate, playerReady]);

  useEffect(() => {
    if (!playerReady || !queuedReleaseModeRef.current) return;
    commitRendererGate(queuedReleaseModeRef.current);
  }, [commitRendererGate, playerReady]);

  useEffect(() => () => {
    if (gateReleaseTimerRef.current != null) window.clearTimeout(gateReleaseTimerRef.current);
    if (revealTimerRef.current != null) window.clearTimeout(revealTimerRef.current);
  }, []);

  const beginTuneIn = useCallback(() => {
    if (offline) return;
    setManualGate(false);
    setGateReleasing(false);
    setRendererStarting(true);

    // The pre-paint bootstrap owns the authoritative first-visit class. Read it
    // directly here as well as React state so an already-persisted Lite user can
    // never race hydration and accidentally request the Full effects chunk.
    const selectedLite = document.documentElement.classList.contains('lite') || lite;
    if (selectedLite) {
      setFullRequested(false);
      tuneInFromOverlay();
      requestAnimationFrame(() => requestAnimationFrame(() => releaseRendererGate('lite')));
      return;
    }

    // This boolean is the only point that renders the React.lazy boundary, so
    // the Kawarp/Newpixie chunk is not requested merely by visiting the page.
    setFullRequested(true);
    tuneInFromOverlay();
  }, [lite, offline, releaseRendererGate, tuneInFromOverlay]);

  const handleFullReady = useCallback(() => {
    if (lite) return;
    releaseRendererGate('full');
  }, [lite, releaseRendererGate]);

  // A WebGL failure must never strand somebody behind the gate. The lazy chunk
  // still remains isolated; this is only a bounded release fallback after Full
  // was explicitly chosen and Tune In was pressed.
  useEffect(() => {
    if (!rendererStarting || !fullRequested || lite) return;
    const timeout = window.setTimeout(() => releaseRendererGate('full'), 1800);
    return () => window.clearTimeout(timeout);
  }, [fullRequested, lite, releaseRendererGate, rendererStarting]);

  // External Play (media session) can resume without touching the skin's gate.
  // Honor the stored mode and instantiate only the renderer that was selected.
  useEffect(() => {
    if (!tunedIn || rendererStarting || rendererMode !== 'shell') return;
    if (lite) {
      setRendererMode('lite');
    } else {
      setRendererStarting(true);
      setFullRequested(true);
    }
  }, [lite, rendererMode, rendererStarting, tunedIn]);

  useEffect(() => {
    if (tunedIn || rendererStarting) return;
    setRendererMode('shell');
    setFullRequested(false);
  }, [rendererStarting, tunedIn]);

  const handleSxTune = useCallback(() => {
    if (tunedIn) {
      setManualGate(true);
      setRendererMode('shell');
      setFullRequested(false);
      setRendererStarting(false);
      setGateReleasing(false);
      setRendererReveal(false);
      handleTune();
      return;
    }
    beginTuneIn();
  }, [beginTuneIn, handleTune, tunedIn]);

  const choosePerformance = useCallback((nextLite: boolean) => {
    if (rendererStarting) return;
    setLite(nextLite);
    setRendererMode('shell');
    setFullRequested(false);
  }, [rendererStarting, setLite]);

  const coverSrc = !offline && presentedTrack?.subsonic_id
    ? client.coverUrl(presentedTrack.subsonic_id)
    : null;
  const ambientCoverSrc = !offline && nowPlaying?.subsonic_id
    ? client.coverUrl(nowPlaying.subsonic_id)
    : null;
  const [coverFailed, setCoverFailed] = useState(false);
  useEffect(() => setCoverFailed(false), [coverSrc]);
  const visibleCoverSrc = coverSrc && !coverFailed ? coverSrc : null;
  // Exit snapshots are keyed to BOTH semantic identities. They may survive a
  // view close, but never a new airing recording or a delayed document lookup.
  type VisibleLyricSnapshot = {key: string; document: NonNullable<typeof liveLyrics.document>;
    title: string; artist: string; album: string; cover: string | null;
    positionMs: number | null; duration: number | null};
  const [lastLyricsSnapshot, setLastLyricsSnapshot] = useState<VisibleLyricSnapshot | null>(null);
  const liveLyricSnapshot: VisibleLyricSnapshot | null = lyricsOpen && presentedMatchesAiring && liveLyrics.document ? {
    key: trackIdentity(presentedTrack), document: liveLyrics.document,
    title: presentedTrack?.title ?? '', artist: presentedTrack?.artist ?? '',
    album: [presentedTrack?.album, presentedTrack?.year].filter(Boolean).join(' · '),
    cover: visibleCoverSrc, positionMs: lyricsEstimatedMs,
    duration: presentedTrack?.duration ?? null,
  } : null;
  // Capture last accepted document after commit; an unavailable next recording
  // may animate this document out but can never display it as that new song.
  useLayoutEffect(() => {
    if (!liveLyricSnapshot) return;
    setLastLyricsSnapshot(last => last?.key === liveLyricSnapshot.key &&
      last.document === liveLyricSnapshot.document && last.positionMs === liveLyricSnapshot.positionMs &&
      last.cover === liveLyricSnapshot.cover ? last : liveLyricSnapshot);
  }, [liveLyricSnapshot]);
  const renderedLyrics = liveLyricSnapshot ??
    (!lyricsSceneRequested && lyricsSurfaceActive && lastLyricsSnapshot?.key === trackIdentity(nowPlaying) &&
      lastLyricsSnapshot.key === trackIdentity(presentedTrack) ? lastLyricsSnapshot : null);
  const lyricsSceneActive = lyricsSurfaceActive;
  const compactLyricsTitle = presentedTrack?.title ?? 'Somewhere on the dial';
  const compactLyricsArtist = presentedTrack?.artist ?? 'Unknown artist';
  const compactLyricsAlbum = [presentedTrack?.album, presentedTrack?.year].filter(Boolean).join(' · ') || 'live broadcast';
  const compactLyricsCover = visibleCoverSrc;
  const trackHandoffActive = isTrackHandoffActive(presentationPhase, handoffPresentation);
  const visibleHandoff = trackHandoffActive ? handoffPresentation : null;
  const handoffOutgoingCoverSrc = visibleHandoff?.outgoing?.subsonic_id
    ? client.coverUrl(visibleHandoff.outgoing.subsonic_id)
    : null;
  const handoffIncomingCoverSrc = visibleHandoff?.incoming?.subsonic_id
    ? client.coverUrl(visibleHandoff.incoming.subsonic_id)
    : null;
  const handoffHasCover = Boolean(handoffOutgoingCoverSrc || handoffIncomingCoverSrc);
  const heroHasCover = Boolean(visibleCoverSrc || handoffHasCover);
  const coverColors = useCoverColors(visibleCoverSrc);
  // Incoming artwork already reaches Kawarp while the semantic title can
  // remain outgoing for the entire 6.18-second identity handoff. Never derive
  // foreground polarity solely from presentedTrack's delayed cover colours.
  const ambientCoverColors = useCoverColors(ambientCoverSrc);
  const [lightAmbient, setLightAmbient] = useState(false);
  const lightAmbientRef = useRef(false);
  const [artworkFadeVersion, setArtworkFadeVersion] = useState(0);
  const artworkFadeRef = useRef<ArtworkPolarityFade | null>(null);
  const lastArtworkRgbRef = useRef<ArtworkRgb | null>(null);
  const activeArtworkSrcRef = useRef(ambientCoverSrc);
  activeArtworkSrcRef.current = ambientCoverSrc;
  const incomingArtworkRgb = ambientCoverColors.source === ambientCoverSrc
    ? parseArtworkRgb(ambientCoverColors.average) : null;
  const incomingArtworkRgbRef = useRef(incomingArtworkRgb);
  incomingArtworkRgbRef.current = incomingArtworkRgb;

  const beginArtworkPolarityFade = useCallback((source: string) => {
    // An obsolete load must never reset an active crossover. On the very first
    // artwork, there is no outgoing image to interpolate from.
    if (source !== activeArtworkSrcRef.current || artworkFadeRef.current?.source === source) return;
    const now = performance.now();
    const previous = artworkFadeRef.current;
    const from = previous
      ? artworkFadeColor(previous, lastArtworkRgbRef.current, now)
      : lastArtworkRgbRef.current;
    const initial = from ?? incomingArtworkRgbRef.current ?? [4, 4, 4] as ArtworkRgb;
    artworkFadeRef.current = {
      source, from: initial,
      startedAt: from ? now : now - AMBIENT_TRANSITION_MS,
      durationMs: AMBIENT_TRANSITION_MS,
    };
    setArtworkFadeVersion(value => value + 1);
  }, []);

  // ECO uses the ten-second CSS ambient transition but no Kawarp. FULL anchors
  // its polarity fade to Kawarp's successful image load (not metadata arrival).
  useEffect(() => {
    if (!ambientCoverSrc) {
      artworkFadeRef.current = null;
      lastArtworkRgbRef.current = null;
      lightAmbientRef.current = false;
      setLightAmbient(false);
    } else if (rendererMode === 'lite') {
      beginArtworkPolarityFade(ambientCoverSrc);
    }
  }, [ambientCoverSrc, rendererMode, beginArtworkPolarityFade]);

  useEffect(() => {
    const fade = artworkFadeRef.current;
    if (!fade || fade.source !== ambientCoverSrc) return;
    let frame = 0;
    let lastProbeAt = 0;
    const evaluate = (now: number) => {
      if (now - lastProbeAt > 500) {
        lastProbeAt = now;
        const root = rootRef.current;
        if (root) {
          root.dataset.polarityFadeProgress = Math.min(1, Math.max(0,
            (now - fade.startedAt) / fade.durationMs)).toFixed(3);
          root.dataset.polaritySample = incomingArtworkRgbRef.current ? 'ready' : 'pending';
        }
      }
      // If extraction is pending, retain the old polarity. Once the matching
      // sample arrives, evaluate against the *current* fade position.
      const target = incomingArtworkRgbRef.current;
      if (target) {
        // Lead by half of the 3.2s typographic colour tween: the *middle* of
        // the foreground change coincides with the background's legibility
        // crossover, rather than beginning to change after that crossover.
        const rgb = artworkFadeColor(fade, target, now + 1600);
        lastArtworkRgbRef.current = target;
        const next = nextArtworkPolarity(lightAmbientRef.current, rgb);
        if (next !== lightAmbientRef.current) {
          lightAmbientRef.current = next;
          setLightAmbient(next);
        }
      }
      if (now - fade.startedAt < fade.durationMs) frame = requestAnimationFrame(evaluate);
    };
    frame = requestAnimationFrame(evaluate);
    return () => cancelAnimationFrame(frame);
  }, [artworkFadeVersion, ambientCoverSrc, incomingArtworkRgb]);

  const fullVisuals = rendererMode === 'full';
  const liteVisuals = rendererMode === 'lite';
  const phosphoriaMaterial = fullVisuals || liteVisuals;
  const foreground = phosphoriaMaterial && visibleCoverSrc
    ? (lightAmbient ? '#000000' : '#ffffff')
    : '#feffff';
  const opposing = phosphoriaMaterial && visibleCoverSrc
    ? (lightAmbient ? '#ffffff' : '#000000')
    : '#040404';
  // The background base must start its colour change with the incoming
  // artwork, not wait for the title/presentedTrack to swap later.
  const incomingPalette = ambientCoverColors.source === ambientCoverSrc ? ambientCoverColors : null;
  const ambientBase = fullVisuals ? (incomingPalette?.average ?? coverColors.average ?? '#040404') : '#040404';
  const liteBase = incomingPalette?.average ?? coverColors.average ?? '#040404';
  const liteAccent = incomingPalette?.vibrant ?? incomingPalette?.average ?? coverColors.vibrant ?? coverColors.average ?? '#040404';
  const crtTransitionProfile = useMemo(() => ({
    flickerGain: transitionTuning.flicker,
    noiseGain: transitionTuning.noise,
    curvatureGain: transitionTuning.curvature,
  }), [transitionTuning]);

  const rootStyle = useMemo<SxStyle>(() => ({
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    background: '#040404',
    color: uiReady ? foreground : 'transparent',
    '--sx-fg': foreground,
    '--sx-opposing': opposing,
    '--sx-ambient-base': ambientBase,
    '--sx-lite-base': liteBase,
    '--sx-lite-accent': liteAccent,
    '--sx-kawarp-brightness': lightAmbient ? 1.16 : 0.74,
    '--sx-kawarp-contrast': lightAmbient ? 0.90 : 0.96,
    '--sx-track-corridor-preposition-ms': `${TRACK_CORRIDOR_PREPOSITION_MS}ms`,
    '--sx-track-corridor-glide-ms': `${TRACK_CORRIDOR_GLIDE_MS}ms`,
  }), [ambientBase, foreground, liteAccent, liteBase, opposing, lightAmbient, uiReady]);

  useEffect(() => {
    const section = requestSectionRef.current;
    if (!section || requestHintSeen) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setRequestHintSeen(true);
        observer.disconnect();
      }
    }, { threshold: 0.28 });
    observer.observe(section);
    return () => observer.disconnect();
  }, [requestHintSeen]);

  useEffect(() => {
    if (!requestHintSeen) return;
    const sample = 'Ask for a song, artist, mood, or vibe…';
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRequestHint(sample);
      return;
    }
    let index = 0;
    setRequestHint('');
    const id = window.setInterval(() => {
      index += 1;
      setRequestHint(sample.slice(0, index));
      if (index >= sample.length) window.clearInterval(id);
    }, 42);
    return () => window.clearInterval(id);
  }, [requestHintSeen]);

  useEffect(() => {
    // Don't force layout/attach a ResizeObserver for the below-fold composer
    // until it is near the viewport (or already contains user text).
    if (!requestHintSeen && !slip.text) return;
    const textarea = requestRef.current;
    if (!textarea) return;

    const resize = () => {
      if (!slip.text) {
        // The animated instructional ghost owns the empty-state row height.
        // Do not freeze the textarea to its one-line scrollHeight while that
        // ghost is still typing/wrapping.
        textarea.style.height = '';
        textarea.style.overflowY = 'hidden';
        return;
      }
      textarea.style.height = 'auto';
      const style = getComputedStyle(textarea);
      const lineHeight = Number.parseFloat(style.lineHeight) || 48;
      const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const maxHeight = lineHeight * 3 + (Number.isFinite(padding) ? padding : 0);
      const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
      textarea.style.height = `${Math.ceil(nextHeight)}px`;
      textarea.style.overflowY = textarea.scrollHeight > maxHeight + 1 ? 'auto' : 'hidden';
    };

    resize();
    const observer = new ResizeObserver(resize);
    if (textarea.parentElement) observer.observe(textarea.parentElement);
    return () => observer.disconnect();
  }, [requestHintSeen, slip.text]);

  // Same retained-target wheel smoothing used by sxntax.shop. Touch remains
  // native, and reduced-motion users keep the browser's default scroll.
  useEffect(() => {
    const node = scrollportRef.current;
    if (!node) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    if (lite || reduced.matches || 'ontouchstart' in window) return;

    let targetY = node.scrollTop;
    let currentY = node.scrollTop;
    let raf = 0;
    const WHEEL_GAIN = 0.92;
    const TRACKPAD_GAIN = 0.72;
    const FOLLOW = 0.165;
    const MIN_STEP = 0.12;

    const maxScroll = () => Math.max(0, node.scrollHeight - node.clientHeight);
    const step = () => {
      const delta = targetY - currentY;
      if (Math.abs(delta) <= MIN_STEP) {
        currentY = targetY;
        node.scrollTop = currentY;
        raf = 0;
        return;
      }
      currentY += delta * FOLLOW;
      node.scrollTop = currentY;
      raf = requestAnimationFrame(step);
    };
    const queue = (deltaY: number) => {
      const gain = Math.abs(deltaY) < 40 ? TRACKPAD_GAIN : WHEEL_GAIN;
      targetY = Math.max(0, Math.min(maxScroll(), targetY + deltaY * gain));
      if (!raf) {
        currentY = node.scrollTop;
        raf = requestAnimationFrame(step);
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-lyrics-scroll]')) return;
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      event.preventDefault();
      queue(event.deltaY);
    };
    const onScroll = () => {
      if (!raf) {
        currentY = node.scrollTop;
        targetY = currentY;
      }
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [lite]);

  const handleRequestSubmit = (event: FormEvent) => {
    event.preventDefault();
    void slip.send();
  };

  const scrollToSection = (ref: RefObject<HTMLElement | null>) => {
    ref.current?.scrollIntoView({ behavior: lite ? 'auto' : 'smooth', block: 'start' });
  };

  const activeSource = audioRef.current?.currentSrc || audioRef.current?.src || '';
  const hearingOpus = tunedIn && /\/stream\.opus(?:[?#]|$)/i.test(activeSource);
  const activeCodec = hearingOpus ? 'OPUS' : (stream?.format?.toUpperCase() || 'MP3');
  const activeBitrate = hearingOpus ? stream?.opusBitrate : stream?.bitrate;
  const streamLabel = activeCodec
    ? `${activeCodec}${typeof activeBitrate === 'number' && activeBitrate > 0 ? ` ${Math.round(activeBitrate)}Kbps` : ''}`
    : '';

  useKeyboardShortcuts({
    space: handleSxTune,
    k: handleSxTune,
    arrowup: () => adjustVolume(0.05),
    arrowdown: () => adjustVolume(-0.05),
    m: toggleMute,
    r: () => requestRef.current?.focus(),
  }, { disabled: scheduleOpen || lyricsSurfaceActive });

  const statusContext = String(context?.time?.vibe || context?.time?.show || '').toUpperCase();
  const statusWeather = context?.weather && (context.weather.temp != null || context.weather.condition)
    ? [
      context.weather.temp != null ? `${Math.round(context.weather.temp)}°` : '',
      context.weather.condition ?? '',
    ].filter(Boolean).join(' ').toUpperCase()
    : '';
  const statusLine = [
    offline ? 'OFF AIR' : 'LIVE',
    signal.latencyMs != null && tunedIn ? `${signal.latencyMs} MS` : '',
    streamLabel,
    statusContext,
    statusWeather,
    listenerCount != null ? `${listenerCount} LISTENING` : '',
  ].filter(Boolean).join(' · ');

  const ambientMotionSpeed = clampNumber(
    typeof presentedTrack?.bpm === 'number' && presentedTrack.bpm > 0 ? presentedTrack.bpm / 120 : 1,
    0.65,
    1.55,
  );

  const gateVisible = !offline && (showOverlay || manualGate || rendererStarting);
  const rootClasses = [
    styles.root,
    contained ? styles.contained : '',
    playerReady ? '' : styles.presentationPending,
    gateVisible ? styles.gated : '',
    rendererReveal ? styles.rendererReveal : '',
    trackHandoffActive ? styles.trackHandoff : '',
    fullVisuals ? styles.fullVisuals : '',
    liteVisuals ? styles.liteVisuals : '',
  ].filter(Boolean).join(' ');

  if (!uiReady) {
    const frameInset = contained ? 10 : 18;
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          background: '#040404',
          color: '#feffff',
        }}
        data-sx-boot-shell="true"
        data-sxntax-revision={SXNTAX_SKIN_REVISION}
      data-station-clock={stationClock.nowMs() === null ? 'legacy' : 'server-monotonic'}
      >
        <span ref={cssReadyProbeRef} className={styles.cssReadyProbe} aria-hidden="true" />
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: frameInset,
            border: '1px solid rgba(254,255,255,.76)',
            borderRadius: 8,
          }}
        />
        {showBootGauge && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              width: 'min(240px, 24vw)',
              height: 2,
              transform: 'translate(-50%, -50%)',
              background: 'rgba(254,255,255,.28)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${Math.max(8, Math.round(bootProgress * 100))}%`,
                height: '100%',
                background: '#feffff',
              }}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={rootClasses}
      style={{
        ...rootStyle,
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        background: '#040404',
      }}
      data-light-ambient={phosphoriaMaterial && lightAmbient ? 'true' : 'false'}
      data-polarity-engine="artwork-crossfade"
      data-renderer={rendererMode}
      data-sxntax-revision={SXNTAX_SKIN_REVISION}
      data-station-clock={stationClock.nowMs() === null ? 'legacy' : 'server-monotonic'}
    >
      <span ref={cssReadyProbeRef} className={styles.cssReadyProbe} aria-hidden="true" />
      <div className={styles.ambientBase} aria-hidden="true" />
      {liteVisuals && <LiteAmbient />}
      {liteVisuals && <div className={styles.litePhosphor} aria-hidden="true" />}
      {fullRequested && !lite && (
        <Suspense fallback={null}>
          <FullEffects
            coverSrc={ambientCoverSrc}
            audioRef={audioRef}
            tunedIn={tunedIn}
            animationSpeed={ambientMotionSpeed}
            transitionDuration={AMBIENT_TRANSITION_MS}
            transitionIntensityRef={transitionIntensityRef}
            transitionProfile={crtTransitionProfile}
            lightAmbient={lightAmbient}
            onArtworkLoaded={beginArtworkPolarityFade}
            emphasisTargetRef={rootRef}
            onReady={handleFullReady}
          />
        </Suspense>
      )}
      <RadioFrame clock={stationClockSeconds(
        stationClock.nowMs() === null ? clock : new Date(stationClock.nowMs()!), timezone, stationLocale,
      )} />

      {playerReady && (
      <div className={`${styles.scrollport} ${scheduleOpen ? styles.scheduleScrollportHidden : ''}`} ref={scrollportRef} data-player-scrollport>
        <main className={styles.page}>
          <section className={styles.hero} aria-label="Now playing">
            <div className={styles.heroStage} ref={heroStageRef} data-track-fit-stage data-lyrics-ui-revision="typography-rc2" data-presented-key={trackIdentity(presentedTrack)} data-airing-key={trackIdentity(nowPlaying)} data-lyrics-intent={lyricsWanted ? "lyrics" : "artwork"} data-lyrics-presentation={presentationPhase} data-lyrics-view={lyricsViewPhase}>
              <div className={styles.heroSpring} aria-hidden="true" />

              <div className={styles.heroHeader} data-hero-header>
                <div className={styles.route}>
                  <a className={styles.routeLink} href="https://sxntax.shop/home/" aria-label="Home">
                    /
                  </a>
                  <a className={`${styles.routeLink} ${styles.routeCurrent}`} href="https://radio.sxntax.shop/" aria-current="page">
                    radio
                  </a>
                </div>
                <div className={styles.stationLine}>
                  {stationName}<span aria-hidden="true"> · </span>
                  <button
                    ref={scheduleTriggerRef}
                    type="button"
                    className={`${styles.routeLink} ${styles.showLink}`}
                    aria-label={`View schedule. Current show: ${showName || 'Freeform'}`}
                    aria-haspopup="dialog"
                    aria-expanded={scheduleOpen}
                    aria-controls={scheduleId}
                    title="View schedule"
                    onPointerEnter={() => { void loadScheduleModal().catch(() => {}); }}
                    onFocus={() => { void loadScheduleModal().catch(() => {}); }}
                    onKeyDown={event => { if (event.key === ' ') event.stopPropagation(); }}
                    onClick={() => setScheduleOpen(true)}
                  >{showName || 'Schedule'}</button>
                </div>
                <div className={styles.statusLine}>{statusLine}</div>
              </div>

              <div className={styles.heroSpringInner} aria-hidden="true" />

              <div className={styles.heroMain} data-hero-main>
                <div
                  className={`${styles.trackCorridor} ${presentationPhase === 'rewrite' ? styles.trackCorridorRewrite : ''}`}
                >
                  <div
                    ref={nowClusterRef}
                    className={`${styles.nowCluster} ${lyricsSceneActive ? styles.nowClusterLyrics : ''} ${presentationPhase === 'decay' ? styles.trackDecay : presentationPhase === 'rewrite' ? styles.trackRewrite : ''}`}
                    data-hero-now
                    tabIndex={-1}
                  >
                  <div className={styles.nowHeading} data-hero-heading>
                    <SectionTag hero>{offline ? 'OFF AIR' : 'NOW PLAYING'}</SectionTag>
                    {(
                      <div className={styles.lyricsTrackIdentity} aria-label="Current song"
                        title={`${compactLyricsTitle} — ${compactLyricsArtist}`}>
                        <div className={`${styles.lyricsIdentityCopy} ${visibleHandoff ? styles.lyricsIdentityInHandoff : ''}`}>
                          <div className={styles.lyricsIdentityResting}>
                            <div className={styles.lyricsIdentityTitle}>{compactLyricsTitle}</div>
                            <div className={styles.lyricsIdentityArtist}>{compactLyricsArtist}</div>
                            <div className={styles.lyricsIdentityAlbum}>{compactLyricsAlbum}</div>
                          </div>
                          {visibleHandoff && (
                            <div className={styles.lyricsIdentityBridge} aria-hidden="true">
                              <div className={styles.lyricsCompactOutgoing}>
                                <div className={styles.lyricsIdentityTitle}>{visibleHandoff.outgoing?.title ?? 'Somewhere on the dial'}</div>
                                <div className={styles.lyricsIdentityArtist}>{visibleHandoff.outgoing?.artist ?? 'Unknown artist'}</div>
                                <div className={styles.lyricsIdentityAlbum}>{bridgeAlbum(visibleHandoff.outgoing)}</div>
                              </div>
                              <div className={styles.lyricsCompactIncoming}>
                                <div className={styles.lyricsIdentityTitle}>{visibleHandoff.incoming?.title ?? 'Somewhere on the dial'}</div>
                                <div className={styles.lyricsIdentityArtist}>{visibleHandoff.incoming?.artist ?? 'Unknown artist'}</div>
                                <div className={styles.lyricsIdentityAlbum}>{bridgeAlbum(visibleHandoff.incoming)}</div>
                              </div>
                              <div className={styles.lyricsCompactOutgoingMass}>
                                <div className={styles.lyricsIdentityTitle}>{visibleHandoff.outgoing?.title ?? 'Somewhere on the dial'}</div>
                                <div className={styles.lyricsIdentityArtist}>{visibleHandoff.outgoing?.artist ?? 'Unknown artist'}</div>
                              </div>
                              <div className={styles.lyricsCompactIncomingMass}>
                                <div className={styles.lyricsIdentityTitle}>{visibleHandoff.incoming?.title ?? 'Somewhere on the dial'}</div>
                                <div className={styles.lyricsIdentityArtist}>{visibleHandoff.incoming?.artist ?? 'Unknown artist'}</div>
                              </div>
                            </div>
                          )}
                        </div>
                        <figure className={`${styles.coverPlate} ${styles.lyricsCoverPlate}`} aria-hidden="true">
                          {visibleHandoff && handoffHasCover ? (
                            <>
                              {handoffOutgoingCoverSrc && <img src={handoffOutgoingCoverSrc} alt="" className={`${styles.cover} ${styles.coverLayer} ${styles.coverOutgoing}`} decoding="async" />}
                              {handoffIncomingCoverSrc && <img src={handoffIncomingCoverSrc} alt="" className={`${styles.cover} ${styles.coverLayer} ${styles.coverIncoming}`} decoding="async" />}
                            </>
                          ) : compactLyricsCover ? <img src={compactLyricsCover} alt="" className={styles.cover} decoding="async" /> : <span className={styles.lyricsCoverFallback}>SW</span>}
                        </figure>
                      </div>
                    )}
                  </div>
                  <div data-artwork-surface className={`${styles.nowGrid} ${heroHasCover ? '' : styles.nowGridNoCover}`} aria-hidden={lyricsSceneActive} inert={lyricsSceneActive}>
                   <div className={styles.nowCopy} data-hero-copy>
                       <AdaptiveTrackTitle
                        title={offline ? 'Radio silence.' : (presentedTrack?.title ?? 'Somewhere on the dial')}
                        artist={offline ? '' : (presentedTrack?.artist ?? 'Unknown artist')}
                        album={offline ? '' : ([presentedTrack?.album, presentedTrack?.year].filter(Boolean).join(' · ') || 'live broadcast')}
                        stageRef={heroStageRef}
                        hasCover={heroHasCover}
                        layoutRevision={trackLayoutRevision}
                        preparedFit={preparedTrackFit?.key === trackIdentity(presentedTrack) ? preparedTrackFit : null}
                        onLayoutSettled={layoutRevision => {
                          const presentedKey = trackIdentity(presentedTrackRef.current);
                          if (layoutRevision !== expectedLiveLayoutRevisionRef.current) return;
                          const pending = liveLayoutSettledKeyRef.current;
                          if (typeof pending === 'string' && pending.startsWith('pending:') && !pending.startsWith(`pending:${presentedKey}@${layoutRevision}`)) return;
                          liveLayoutSettledKeyRef.current = presentedKey;
                        }}
                      />
                      {!offline && (
                        <>
                          <div className={styles.artist} data-hero-artist>{presentedTrack?.artist ?? 'Unknown artist'}</div>
                          <div className={styles.albumLine} data-hero-album>
                            {[presentedTrack?.album, presentedTrack?.year].filter(Boolean).join(' · ') || 'live broadcast'}
                          </div>
                        </>
                      )}
                    </div>

                    {visibleHandoff && (
                      <div className={styles.identityBridge} aria-hidden="true">
                        <div
                          className={`${styles.bridgeTextLayer} ${styles.bridgeOutgoingCore} ${visibleHandoff.outgoing?.subsonic_id ? '' : styles.bridgeNoCover}`}
                          style={typographySnapshotStyle(visibleHandoff.outgoingTypography)}
                        >
                          <div className={`${styles.bridgeTitle} ${hasCjk(visibleHandoff.outgoing?.title ?? '') ? styles.titleCjk : ''}`}>
                            {bridgeTitle(visibleHandoff.outgoing, visibleHandoff.outgoingTypography)}
                          </div>
                          <div className={styles.bridgeArtist}>{visibleHandoff.outgoing?.artist ?? 'Unknown artist'}</div>
                          <div className={styles.bridgeAlbumLine}>{bridgeAlbum(visibleHandoff.outgoing)}</div>
                        </div>
                        <div
                          className={`${styles.bridgeTextLayer} ${styles.bridgeOutgoingMass} ${visibleHandoff.outgoing?.subsonic_id ? '' : styles.bridgeNoCover}`}
                          style={typographySnapshotStyle(visibleHandoff.outgoingTypography)}
                        >
                          <div className={`${styles.bridgeTitle} ${hasCjk(visibleHandoff.outgoing?.title ?? '') ? styles.titleCjk : ''}`}>
                            {bridgeTitle(visibleHandoff.outgoing, visibleHandoff.outgoingTypography)}
                          </div>
                          <div className={styles.bridgeArtist}>{visibleHandoff.outgoing?.artist ?? 'Unknown artist'}</div>
                          <div className={styles.bridgeAlbumLine}>{bridgeAlbum(visibleHandoff.outgoing)}</div>
                        </div>
                        <div
                          className={`${styles.bridgeTextLayer} ${styles.bridgeIncomingCore} ${visibleHandoff.incoming?.subsonic_id ? '' : styles.bridgeNoCover}`}
                          style={typographySnapshotStyle(visibleHandoff.incomingTypography)}
                        >
                          <div className={`${styles.bridgeTitle} ${hasCjk(visibleHandoff.incoming?.title ?? '') ? styles.titleCjk : ''}`}>
                            {bridgeTitle(visibleHandoff.incoming, visibleHandoff.incomingTypography)}
                          </div>
                          <div className={styles.bridgeArtist}>{visibleHandoff.incoming?.artist ?? 'Unknown artist'}</div>
                          <div className={styles.bridgeAlbumLine}>{bridgeAlbum(visibleHandoff.incoming)}</div>
                        </div>
                        <div
                          className={`${styles.bridgeTextLayer} ${styles.bridgeIncomingMass} ${visibleHandoff.incoming?.subsonic_id ? '' : styles.bridgeNoCover}`}
                          style={typographySnapshotStyle(visibleHandoff.incomingTypography)}
                        >
                          <div className={`${styles.bridgeTitle} ${hasCjk(visibleHandoff.incoming?.title ?? '') ? styles.titleCjk : ''}`}>
                            {bridgeTitle(visibleHandoff.incoming, visibleHandoff.incomingTypography)}
                          </div>
                          <div className={styles.bridgeArtist}>{visibleHandoff.incoming?.artist ?? 'Unknown artist'}</div>
                          <div className={styles.bridgeAlbumLine}>{bridgeAlbum(visibleHandoff.incoming)}</div>
                        </div>
                      </div>
                    )}

                    {visibleHandoff && handoffHasCover ? (
                      <figure className={`${styles.coverPlate} ${styles.coverHandoff}`}>
                        {handoffOutgoingCoverSrc && (
                          <img
                            src={handoffOutgoingCoverSrc}
                            alt=""
                            className={`${styles.cover} ${styles.coverLayer} ${styles.coverOutgoing}`}
                            decoding="async"
                          />
                        )}
                        {handoffIncomingCoverSrc && (
                          <img
                            src={handoffIncomingCoverSrc}
                            alt=""
                            className={`${styles.cover} ${styles.coverLayer} ${styles.coverIncoming}`}
                            decoding="async"
                          />
                        )}
                      </figure>
                    ) : visibleCoverSrc ? (
                      <figure className={styles.coverPlate}>
                        <img
                          src={visibleCoverSrc}
                          alt=""
                          className={styles.cover}
                          loading="eager"
                          decoding="async"
                          fetchPriority="high"
                          onError={() => setCoverFailed(true)}
                        />
                      </figure>
                    ) : null}
                  </div>
                  {lyricsSceneActive && renderedLyrics && (
                    <div className={styles.lyricsDocument} data-lyric-key={renderedLyrics.key}>
                    <LyricsPerspective
                      key={renderedLyrics!.key}
                      onClose={closeLyrics}
                      document={renderedLyrics!.document}
                      estimatedPositionMs={lyricsOpen ? lyricsEstimatedMs : renderedLyrics!.positionMs}
                      stationClock={stationClock}
                      audioElement={audioElement}
                      listenerStartedAtMs={lyricsOpen && presentedMatchesAiring ? trackStartedAt : null}
                      listenerPausedAtMs={lyricsOpen && presentedMatchesAiring ? trackPausedAt : null}
                      durationSeconds={renderedLyrics!.duration}
                      trackTitle={renderedLyrics!.title}
                      trackArtist={renderedLyrics!.artist}
                      trackAlbum={renderedLyrics!.album}
                      artworkSrc={renderedLyrics!.cover}
                      preview={lyricsPreview}
                      lite={lite}
                    />
                    </div>
                  )}
                  {lyricsSceneActive && !renderedLyrics && (
                    <div className={styles.lyricsPending} data-lyrics-pending role="status" aria-live="polite">
                      <span className={styles.lyricsPendingDots} aria-hidden="true"><i /><i /><i /></span>
                      <span className={styles.srOnly}>{liveLyrics.status === 'error' ? 'Lyrics temporarily unavailable' : 'Loading lyrics'}</span>
                    </div>
                  )}
                  </div>
                </div>

                {!offline && (
                  <div className={styles.progressBlock} data-hero-progress>
                    <div className={styles.progressMeta}>
                      <span>{fmtTime(elapsed)}</span>
                      <span>{presentedTrack?.duration ? fmtTime(presentedTrack.duration) : 'LIVE'}</span>
                    </div>
                    <div className={styles.progressTrack} aria-hidden="true">
                      <span
                        className={styles.progressFill}
                        style={{ width: ratio == null ? '0%' : `${Math.round(ratio * 1000) / 10}%` }}
                      />
                    </div>
                  </div>
                )}

                {(trackFacts.bpm || trackFacts.musicalKey || trackFacts.genres.length > 0) && (
                  <div
                    className={styles.trackFacts}
                    data-hero-facts
                    title={trackFacts.tooltip}
                  >
                    {trackFacts.bpm && <span className={styles.metaTag}>{trackFacts.bpm}</span>}
                    {trackFacts.musicalKey && <span className={styles.metaTag}>{trackFacts.musicalKey}</span>}
                    {trackFacts.genres.length > 0 && (
                      <span className={styles.genreFacts}>{trackFacts.genres.join(' · ')}</span>
                    )}
                  </div>
                )}
              </div>

              <div className={styles.heroSpringInner} aria-hidden="true" />

              <div className={styles.controls} data-hero-controls>
                <button
                  type="button"
                  className={styles.action}
                  onClick={handleSxTune}
                  disabled={offline}
                >
                  {offline ? 'OFF AIR' : tunedIn ? '■ TUNE OUT' : '▶ TUNE IN'}
                </button>

                {like.available && (
                  <button
                    type="button"
                    className={styles.action}
                    onClick={() => void like.like()}
                    disabled={like.pending}
                    aria-pressed={like.liked}
                    aria-label={like.liked ? 'Unlike this track' : 'Like this track'}
                  >
                    <NerdIcon>{like.liked ? '\uF004' : '\uF08A'}</NerdIcon> {like.liked ? 'LIKED' : 'LIKE'}{like.count > 0 ? ` ${like.count}` : ''}
                  </button>
                )}

                <button
                  ref={lyricsTriggerRef}
                  type="button"
                  className={styles.action}
                  onClick={() => {
                    if (lyricsWanted) closeLyrics();
                    else if (lyricsAvailable) {
                      lyricsFrameRequestedRef.current = true;
                      setLyricsWanted(true);
                    }
                  }}
                  disabled={!lyricsAvailable && !lyricsWanted}
                  aria-label={lyricsWanted ? 'Turn off automatic lyrics view' : lyricsAvailable ? 'Show lyrics' : 'Lyrics unavailable'}
                  aria-pressed={lyricsWanted}
                  data-lyrics-availability={lyricsPreview ? 'preview' : liveLyrics.status}
                  aria-controls="sxntax-lyrics-perspective"
                >
                  <LyricsIcon /> LYRICS
                </button>

                <button
                  type="button"
                  className={styles.action}
                  onClick={() => scrollToSection(requestSectionRef)}
                >
                  <NerdIcon>{'\u{F09E5}'}</NerdIcon> REQUEST
                </button>

                <button
                  type="button"
                  className={styles.action}
                  onClick={() => scrollToSection(airSectionRef)}
                >
                  <NerdIcon></NerdIcon> HISTORY
                </button>

                <div className={styles.volumeGroup}>
                  <button
                    type="button"
                    className={styles.action}
                    onClick={toggleMute}
                  >
                    <NerdIcon>{muted ? '\uF026' : '\uF028'}</NerdIcon> {muted ? 'UNMUTE' : 'MUTE'}
                  </button>
                  <button
                    type="button"
                    className={styles.action}
                    onClick={() => adjustVolume(-0.05)}
                    aria-label="Volume down"
                  >−</button>
                  <span className={styles.volumeReadout}>VOL {Math.round(volume * 100)}</span>
                  <button
                    type="button"
                    className={styles.action}
                    onClick={() => adjustVolume(0.05)}
                    aria-label="Volume up"
                  >+</button>
                </div>
              </div>

              <div className={styles.heroSpring} aria-hidden="true" />
            </div>
          </section>

          <div className={styles.geometryProbe} aria-hidden="true">
            <div className={styles.heroStage} ref={geometryProbeStageRef} data-track-fit-stage>
              <div className={styles.heroSpring} />
              <div className={styles.heroHeader} data-hero-header>
                <div className={styles.route}>/radio</div>
                <div className={styles.stationLine}>{stationName} · <span className={`${styles.routeLink} ${styles.showLink}`}>{showName || 'Schedule'}</span></div>
                <div className={styles.statusLine}>{statusLine}</div>
              </div>
              <div className={styles.heroSpringInner} />
              <div className={styles.heroMain} data-hero-main>
                <div ref={geometryProbeNowRef} className={styles.nowCluster} data-hero-now>
                  <div className={styles.nowHeading} data-hero-heading><SectionTag>NOW PLAYING</SectionTag></div>
                  <div data-artwork-surface className={`${styles.nowGrid} ${nowPlaying?.subsonic_id ? '' : styles.nowGridNoCover}`}>
                    <div className={styles.nowCopy} data-hero-copy>
                      <AdaptiveTrackTitle
                        title={nowPlaying?.title ?? 'Somewhere on the dial'}
                        artist={nowPlaying?.artist ?? 'Unknown artist'}
                        album={[nowPlaying?.album, nowPlaying?.year].filter(Boolean).join(' · ') || 'live broadcast'}
                        stageRef={geometryProbeStageRef}
                        hasCover={Boolean(nowPlaying?.subsonic_id)}
                        onLayoutSettled={() => {
                          if (trackIdentity(incomingTrackRef.current) !== incomingTrackKey) return;
                          const node = geometryProbeNowRef.current;
                          if (!node) return;
                          const geometry = measureTrackGeometry(
                            incomingTrackKey, nowPlaying, geometryProbeStageRef.current, node,
                          );
                          if (geometry) incomingGeometryRef.current = geometry;
                        }}
                      />
                      <div className={styles.artist}>{nowPlaying?.artist ?? 'Unknown artist'}</div>
                      <div className={styles.albumLine}>
                        {[nowPlaying?.album, nowPlaying?.year].filter(Boolean).join(' · ') || 'live broadcast'}
                      </div>
                    </div>
                    {nowPlaying?.subsonic_id && <figure className={styles.coverPlate} />}
                  </div>
                </div>
                <div className={styles.progressBlock} data-hero-progress>
                  <div className={styles.progressMeta}><span>0:00</span><span>0:00</span></div>
                  <div className={styles.progressTrack} />
                </div>
                {(incomingTrackFacts.bpm || incomingTrackFacts.musicalKey || incomingTrackFacts.genres.length > 0) && (
                  <div className={styles.trackFacts} data-hero-facts>
                    {incomingTrackFacts.bpm && <span className={styles.metaTag}>{incomingTrackFacts.bpm}</span>}
                    {incomingTrackFacts.musicalKey && <span className={styles.metaTag}>{incomingTrackFacts.musicalKey}</span>}
                    {incomingTrackFacts.genres.length > 0 && <span className={styles.genreFacts}>{incomingTrackFacts.genres.join(' · ')}</span>}
                  </div>
                )}
              </div>
              <div className={styles.heroSpringInner} />
              <div className={styles.controls} data-hero-controls>
                <span>■ TUNE OUT</span><span>♡ LIKE</span><span>▣ REQUEST</span><span>↶ HISTORY</span><span>◖ MUTE</span><span>− VOL 100 +</span>
              </div>
              <div className={styles.heroSpring} />
            </div>
          </div>

          <section ref={requestSectionRef} className={styles.requestSection} aria-label="Request a song">
            <div className={styles.sectionHeader}>
              <SectionTag>DEAR DJ</SectionTag>
              {slip.ack && (
                <button type="button" className={styles.textAction} onClick={slip.reset}>
                  NEW REQUEST
                </button>
              )}
            </div>
            {slip.ack ? (
              <div className={styles.ackRow}>
                <p>{slip.ack}</p>
              </div>
            ) : (
              <form onSubmit={handleRequestSubmit} className={styles.requestForm}>
                <div className={styles.requestLine}>
                  <div className={styles.requestInputWrap}>
                    {!slip.text && (
                      <span className={styles.requestHintGhost} aria-hidden="true">{requestHint}</span>
                    )}
                    <textarea
                      ref={requestRef}
                      value={slip.text}
                      onChange={event => slip.setText(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          if (!slip.sending && slip.text.trim()) {
                            event.currentTarget.form?.requestSubmit();
                          }
                        }
                      }}
                      maxLength={REQUEST_TEXT_MAX}
                      rows={1}
                      aria-label="Request"
                    />
                  </div>
                  <button
                    type="submit"
                    className={styles.sendAction}
                    disabled={slip.sending || !slip.text.trim()}
                  >
                    {slip.sending ? 'SENDING…' : 'SEND ↗'}
                  </button>
                </div>
                <label className={styles.fromLine}>
                  <span>FROM</span>
                  <input
                    value={slip.name}
                    onChange={event => slip.setName(event.target.value)}
                    placeholder="your name (optional)"
                    maxLength={REQUEST_NAME_MAX}
                  />
                </label>
              </form>
            )}
          </section>

          <section ref={airSectionRef} className={styles.feedSection} aria-label="Air history">
              <SectionTag>AIR</SectionTag>
              <div className={styles.airLogList}>
                <article className={`${styles.airRow} ${styles.nextAirRow} ${upNext?.subsonic_id ? styles.airRowWithArt : ''}`}>
                  <div className={styles.airStamp}>NEXT</div>
                  {upNext?.subsonic_id && (
                    <AirArtwork
                      src={client.coverUrl(upNext.subsonic_id)}
                      alt={upNext.album ? `${upNext.album} cover` : ''}
                    />
                  )}
                  <div className={styles.airBody}>
                    {upNext?.title ? (
                      <>
                        <div className={styles.airTrack}>
                          <strong>{upNext.title}</strong>
                          {upNext.artist && <span>— {upNext.artist}</span>}
                        </div>
                        {upNext.album && <div className={styles.airMeta}>{upNext.album}</div>}
                        {air.nextReason && <p className={styles.airReason}>{air.nextReason}</p>}
                      </>
                    ) : (
                      <div className={`${styles.airTrack} ${styles.nextPending}`}><SelectingLabel /></div>
                    )}
                  </div>
                </article>

                {air.current && (
                  <article className={`${styles.airRow} ${styles.currentAirRow} ${air.current.subsonic_id ? styles.airRowWithArt : ''}`}>
                    <div className={styles.airStamp}>NOW</div>
                    {air.current.subsonic_id && (
                      <AirArtwork
                        src={client.coverUrl(air.current.subsonic_id)}
                        alt={air.current.album ? `${air.current.album} cover` : ''}
                      />
                    )}
                    <div className={styles.airBody}>
                      <div className={styles.airTrack}>
                        <strong>{air.current.title ?? '?'}</strong>
                        {air.current.artist && <span>— {air.current.artist}</span>}
                      </div>
                      {air.current.album && <div className={styles.airMeta}>{air.current.album}</div>}
                      {air.currentReason && <p className={styles.airReason}>{air.currentReason}</p>}
                    </div>
                  </article>
                )}

                {air.rows.map(row => (
                  row.kind === 'track' ? (
                    <article className={`${styles.airRow} ${row.entry.subsonic_id ? styles.airRowWithArt : ''}`} key={row.key}>
                      <time className={styles.airStamp}>{turnClock(row.t, timezone, stationLocale)}</time>
                      {row.entry.subsonic_id && (
                        <AirArtwork
                          src={client.coverUrl(row.entry.subsonic_id)}
                          alt={row.entry.album ? `${row.entry.album} cover` : ''}
                        />
                      )}
                      <div className={styles.airBody}>
                        <div className={styles.airTrack}>
                          <strong>{row.entry.title ?? '?'}</strong>
                          {row.entry.artist && <span>— {row.entry.artist}</span>}
                        </div>
                        {row.entry.album && <div className={styles.airMeta}>{row.entry.album}</div>}
                        {row.reason && <p className={styles.airReason}>{row.reason}</p>}
                      </div>
                    </article>
                  ) : (
                    <article className={`${styles.airRow} ${styles.voiceAirRow}`} key={row.key}>
                      <time className={styles.airStamp}>{turnClock(row.t, timezone, stationLocale)}</time>
                      <div className={styles.airBody}>
                        <div className={styles.airSpeaker}>{row.speaker ?? djName}</div>
                        <p className={styles.airVoice}>{row.text}</p>
                      </div>
                    </article>
                  )
                ))}
              </div>
            </section>

          <div className={styles.bottomSpace} />
        </main>
      </div>

      )}
      {gateVisible && (
        <div
          className={`${styles.tuneOverlay} ${gateReleasing ? styles.tuneOverlayReleasing : ''}`}
          aria-label="Tune in"
          style={{ visibility: uiReady ? 'visible' : 'hidden' }}
        >
          <div
            className={`${styles.tuneGate} ${uiReady ? styles.tuneGateReady : styles.tuneGateBooting} ${rendererStarting ? styles.tuneGateStarting : ''}`}
          >
            <button
              type="button"
              onClick={beginTuneIn}
              className={styles.tunePrompt}
              disabled={rendererStarting}
            >
              <span>▶ TUNE IN</span>
            </button>
            <div className={styles.performanceSelector} role="group" aria-label="Performance mode">
              <button
                type="button"
                className={`${styles.performanceChoice} ${styles.performanceFull}`}
                onClick={() => choosePerformance(false)}
                aria-pressed={!lite}
                disabled={rendererStarting}
              >
                QUALITY
              </button>
              <span className={styles.performanceSlash} aria-hidden="true">/</span>
              <button
                type="button"
                className={`${styles.performanceChoice} ${styles.performanceLite}`}
                onClick={() => choosePerformance(true)}
                aria-pressed={lite}
                disabled={rendererStarting}
              >
                ECO
              </button>
            </div>
          </div>
        </div>
      )}
      {scheduleOpen && (
        <Suspense fallback={null}>
          <ScheduleModal
            id={scheduleId}
            container={rootRef.current}
            triggerRef={scheduleTriggerRef}
            stationName={stationName}
            showName={showName}
            hostName={djName}
            timezone={timezone}
            onClose={() => setScheduleOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
