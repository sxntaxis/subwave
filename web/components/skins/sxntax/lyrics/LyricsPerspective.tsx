'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './LyricsPerspective.module.css';
import type { StationClock } from '@/lib/stationClock';
import './vendor/youlyplus/lyrics.scoped.css';
import type { LyricDocument } from './lyricsModel';
import { createLyricsPreview, type LyricsPreviewMode } from './lyricsPreview';
import { createMonotonicLyricsClock, liveRadioLyricsPositionMs, toYoulyLyrics } from './youlyBridge';
import { createAudibleLyricsClock } from './audibleLyricsClock';

type RendererHandle = {
  cleanupLyrics: () => void;
  isUserControllingScroll: boolean;
  _setUserScrolled: (yes: boolean) => void;
  currentPrimaryActiveLine?: HTMLElement | null;
  _scrollToActiveLine: (line: HTMLElement, force?: boolean) => void;
};
interface LyricsPerspectiveProps {
  onClose: () => void;
  document: LyricDocument | null;
  estimatedPositionMs: number | null;
  preview: LyricsPreviewMode | null;
  lite: boolean;
  stationClock?: StationClock;
  audioElement?: HTMLAudioElement | null;
  listenerStartedAtMs?: number | null;
  listenerPausedAtMs?: number | null;
  durationSeconds?: number | null;
  trackTitle?: string;
  trackArtist?: string;
  trackAlbum?: string;
  artworkSrc?: string | null;
}

const SETTINGS = {
  wordByWord: true,
  lightweight: false,
  blurInactive: true,
  hideOffscreen: false,
  relaxScroll: true,
  bkgOverlap: true,
  hidePhoneticDup: false,
  useSongPaletteFullscreen: false,
  useSongPaletteAllModes: false,
  overridePaletteColor: '',
};

/** Hit-test a real text fragment, not the enclosing full-width lyric row. */
function lyricTextAtPoint(root: HTMLElement, x: number, y: number): HTMLElement | null {
  const doc = window.document;
  const text = doc.elementFromPoint(x, y)?.closest<HTMLElement>('.main-vocal-container, .lyrics-translation-container, .lyrics-romanization-container');
  if (!text || !root.contains(text)) return null;
  // Text ranges expose individual wrapped fragments, unlike element rectangles
  // or caret hit-tests through the FULL renderer's transformed/filter layers.
  const nodes = doc.createTreeWalker(text, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = nodes.nextNode())) {
    if (!/\S/u.test(node.textContent ?? '')) continue;
    const range = doc.createRange();
    range.selectNodeContents(node);
    if ([...range.getClientRects()].some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return text;
  }
  return null;
}

export default function LyricsPerspective({ onClose, document, estimatedPositionMs, preview, lite, stationClock, audioElement = null, listenerStartedAtMs = null, listenerPausedAtMs = null, durationSeconds = null, trackTitle = '', trackArtist = '', trackAlbum = '', artworkSrc = null }: LyricsPerspectiveProps) {
  const previewDocument = useMemo(() => preview ? createLyricsPreview(preview) : null, [preview]);
  const safeDocument = previewDocument ?? document;
  const lyricData = useMemo(() => safeDocument ? toYoulyLyrics(safeDocument) : null, [safeDocument]);
  const clock = useRef(createMonotonicLyricsClock());
  const audible = useRef(createAudibleLyricsClock());
  const latestAudiblePosition = useRef<number | null>(null);
  const latestAudibleMode = useRef<'station' | 'media' | 'stalled' | 'unavailable'>('unavailable');
  const [reportedAudibleMode, setReportedAudibleMode] = useState('unavailable');
  const [reportedAudiblePosition, setReportedAudiblePosition] = useState<number | null>(null);
  const rendererRef = useRef<RendererHandle | null>(null);
  const [needsFollow, setNeedsFollow] = useState(false);
  const [outroHost, setOutroHost] = useState<HTMLElement | null>(null);
  const lyricEndMs = useMemo(() => {
    if (!safeDocument || safeDocument.timing === 'plain') return null;
    let end = 0;
    for (const line of safeDocument.lines) {
      const at = line.endMs ?? line.segments?.at(-1)?.endMs;
      if (typeof at === 'number' && Number.isFinite(at)) end = Math.max(end, at);
    }
    return end || null;
  }, [safeDocument]);
  // An outro appears only after the final SOURCE-timed lyric—not on an
  // estimated end for untimed text or while the document is still loading.
  // Endcards must follow consumed audio, not a station clock that can run
  // ahead while Icecast is buffering on this particular listener.
  const effectivePosition = reportedAudiblePosition ?? estimatedPositionMs;
  const hasFinished = lyricEndMs !== null && effectivePosition !== null &&
    effectivePosition >= lyricEndMs + 900;
  const hoverRef = useRef<{text: HTMLElement; highlight: Highlight} | null>(null);
  const pointerRef = useRef<{x: number; y: number} | null>(null);
  useEffect(() => {
    if (!CSS.highlights) return;
    const style = window.document.createElement('style');
    style.dataset.sxntaxLyricsHighlight = 'true';
    style.textContent = '::highlight(sxntax-lyric-hover) { background-color: color-mix(in srgb, var(--sx-fg) 14%, transparent); }';
    window.document.head.appendChild(style);
    return () => style.remove();
  }, []);
  const clearHover = useCallback(() => {
    const hover = hoverRef.current;
    if (!hover) return;
    if (CSS.highlights?.get('sxntax-lyric-hover') === hover.highlight) CSS.highlights.delete('sxntax-lyric-hover');
    hover.text.removeAttribute('data-lyric-text-hover');
    hoverRef.current = null;
  }, []);
  const hoverText = (root: HTMLElement, x: number, y: number) => {
    if (!CSS.highlights || typeof Highlight === 'undefined') return;
    const text = lyricTextAtPoint(root, x, y);
    if (text === hoverRef.current?.text) return;
    clearHover();
    if (!text) return;
    const range = window.document.createRange();
    range.selectNodeContents(text);
    const highlight = new Highlight(range);
    CSS.highlights.set('sxntax-lyric-hover', highlight);
    text.setAttribute('data-lyric-text-hover', 'true');
    hoverRef.current = {text, highlight};
  };
  useEffect(() => clearHover, [clearHover]);
  const docId = safeDocument?.id ?? null;
  useEffect(() => {
    const timer = window.setInterval(() => {
      setReportedAudiblePosition(latestAudiblePosition.current);
      setReportedAudibleMode(latestAudibleMode.current);
    }, 500);
    return () => window.clearInterval(timer);
  }, [docId]);
  const timeline = useRef({ listenerStartedAtMs, listenerPausedAtMs, durationSeconds, preview: Boolean(preview), previewAt: 0, audioElement, estimatedPositionMs });
  timeline.current = { ...timeline.current, listenerStartedAtMs, listenerPausedAtMs, durationSeconds, preview: Boolean(preview), audioElement, estimatedPositionMs };

  useEffect(() => {
    clock.current.update(estimatedPositionMs);
  }, [estimatedPositionMs]);

  useEffect(() => {
    const esc = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  useEffect(() => {
    if (!lyricData || !docId) return;
    let disposed = false;
    let handle: RendererHandle | null = null;
    let followObserver: ResizeObserver | null = null;
    const storageKey = `subwave:lyrics-offset:${docId}`;
    clock.current.reset(estimatedPositionMs);
    audible.current.reset();
    latestAudiblePosition.current = null;
    latestAudibleMode.current = 'unavailable';
    setReportedAudiblePosition(null);
    const mount = async () => {
      timeline.current.previewAt = performance.now();
      const { default: LyricsPlusRenderer } = await import('./vendor/youlyplus/lyricsRenderer.js');
      if (disposed) return;
      // Use the upstream anchor/padding contract, in the same pixel coordinate
      // system. A nonzero anchor with zero leading runway makes opening targets
      // negative; browser clamping then disagrees with the native spring state.
      const scrollViewport = window.document.querySelector<HTMLElement>('[data-youly-mount]');
      const syncFollowPadding = () => {
        if (disposed || !scrollViewport) return;
        const value = `${lyricData.type === 'None' ? 0 : scrollViewport.clientHeight / 3}px`;
        if (scrollViewport.style.getPropertyValue('--lyrics-scroll-padding-top') !== value) {
          scrollViewport.style.setProperty('--lyrics-scroll-padding-top', value);
        }
      };
      syncFollowPadding();
      if (scrollViewport) {
        followObserver = new ResizeObserver(syncFollowPadding);
        followObserver.observe(scrollViewport);
      }
      const instance = new LyricsPlusRenderer({
        patchParent: '[data-youly-mount]',
        buttonParent: '[data-youly-controls]',
        selectors: ['#lyrics-plus-container-parent'],
        getCurrentTime: () => {
          const { listenerStartedAtMs: start, listenerPausedAtMs: paused, durationSeconds: duration, preview: isPreview, previewAt, audioElement: currentAudio, estimatedPositionMs: currentEstimate } = timeline.current;
          if (isPreview) return (performance.now() - previewAt) / 1000;
          const stationNow = stationClock?.nowMs();
          const pos = stationNow === null || stationNow === undefined ? null
            : liveRadioLyricsPositionMs(start, paused, duration, stationNow);
          const playback = currentAudio;
          const mediaReady = playback !== null && playback.readyState >= 2;
          const result = audible.current.observe({
            stationPositionMs: pos ?? currentEstimate,
            mediaTimeSeconds: mediaReady ? playback.currentTime : null,
            mediaSource: mediaReady ? (playback.currentSrc || playback.src) : null,
            playing: Boolean(playback && !playback.paused && !playback.seeking && playback.readyState >= 3),
            stationPaused: paused !== null,
            monoMs: performance.now(),
          });
          latestAudiblePosition.current = result.positionMs;
          latestAudibleMode.current = result.mode;
          // Diagnostic state is updated at low frequency with the endcard.
          return result.positionMs === null ? clock.current.getTimeSeconds() : result.positionMs / 1000;
        },
        disableSeek: true,
        disableWakeLock: true,
      });
      handle = instance as unknown as RendererHandle;
      rendererRef.current = handle;
      let storedOffset = 0;
      try { storedOffset = Number(window.localStorage.getItem(storageKey) ?? 0) || 0; } catch { /* private mode */ }
      // Native saveLyricsOffsetFn receives (songInfo, offsetMs), not offsetMs alone.
      const saveOffset = (_songInfo: unknown, offsetMs: number) => {
        if (!Number.isFinite(offsetMs)) return;
        try { window.localStorage.setItem(storageKey, String(offsetMs)); } catch { /* private mode */ }
      };
      // Native engine: character wipes, spring scroll, vocal gaps, depth blur,
      // singer split, romanization and translation whenever source fields exist.
      const rendererSettings = { ...SETTINGS, lightweight: lite || window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        relaxScroll: !lite, bkgOverlap: !lite };
      const hasSecondaryText = lyricData.data.some(line => line.translatedText || line.romanizedText);
      const switchDisplayMode = hasSecondaryText ? (mode: string) => {
        if (!disposed) instance.updateDisplayMode(lyricData, mode, rendererSettings);
      } : undefined;
      instance.displayLyrics(
        lyricData,
        { title: '', artist: '', album: '' },
        'none',
        rendererSettings,
        undefined, switchDisplayMode,
        'lyrics', 0, null, saveOffset,
        // YouLyPlus's extension-global provider registry does not exist in the radio.
        // Navidrome already resolved the provider before reaching this renderer.
        () => ({ providerKeys: [], activeProvider: null, providerDisplayNames: {} }), storedOffset,
      );
      // Reserve a quiet end-of-song imprint below the final lyric from the
      // beginning, so revealing it cannot shift a reader's scroll position.
      const transcript = window.document.getElementById('lyrics-plus-container');
      if (transcript) {
        const node = window.document.createElement('div');
        node.dataset.lyricsOutroHost = 'true';
        transcript.appendChild(node);
        setOutroHost(node);
      }
      const target = window.document.getElementById('lyrics-plus-container-parent');
      target?.focus({ preventScroll: true });
    };
    void mount();
    return () => {
      disposed = true;
      followObserver?.disconnect();
      clearHover();
      handle?.cleanupLyrics();
      rendererRef.current = null;
      setOutroHost(null);
      // The renderer owns this dynamically created subtree; React owns the mount.
      window.document.getElementById('lyrics-plus-container')?.remove();
      window.document.getElementById('lyrics-plus-buttons-wrapper')?.remove();
    };
  // The renderer must *not* be recreated on every one-second clock refresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, lyricData, lite, clearHover]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNeedsFollow(Boolean(rendererRef.current?.isUserControllingScroll));
    }, 300);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className={`${styles.perspective} subwave-youly-host`} data-lyrics-perspective="true" data-lyrics-timing={safeDocument?.timing} data-lyrics-engine="youlyplus-v5" data-lyrics-word-policy="per-line" data-lyrics-demo={preview ?? undefined} data-lyrics-rendering={lite ? "eco" : "full"} data-lyrics-clock={audioElement ? "media-anchored" : "station-only"} data-lyrics-clock-state={reportedAudibleMode} data-lyrics-position-ms={reportedAudiblePosition === null ? undefined : Math.round(reportedAudiblePosition)}>
      <div id="lyrics-plus-container-parent" className={styles.scroll} data-lyrics-scroll="true" data-youly-mount tabIndex={0} role="region" aria-label="Lyrics transcript"
        onPointerMove={event => {
          if (event.pointerType !== 'mouse') return;
          pointerRef.current = {x: event.clientX, y: event.clientY};
          hoverText(event.currentTarget, event.clientX, event.clientY);
        }}
        onPointerLeave={() => { pointerRef.current = null; clearHover(); }}
        onScroll={event => {
          const pointer = pointerRef.current;
          if (pointer) hoverText(event.currentTarget, pointer.x, pointer.y);
        }} />
      {outroHost && createPortal(
        <div className={`${styles.outro} ${hasFinished ? styles.outroVisible : ''}`} aria-hidden={!hasFinished} data-lyrics-endcard={hasFinished ? 'visible' : 'pending'}>
          {artworkSrc && <img src={artworkSrc} className={styles.outroArt} alt="" decoding="async" />}
          <div className={styles.outroCopy}>
            <span className={styles.outroLabel}>END OF LYRICS</span>
            <strong>{trackTitle}</strong>
            <span>{trackArtist}</span>
            <small>{trackAlbum}</small>
          </div>
        </div>, outroHost,
      )}
      <div className={styles.nativeControls} data-youly-controls />
      {needsFollow && <button type="button" className={styles.follow} onClick={() => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        renderer._setUserScrolled(false);
        renderer.isUserControllingScroll = false;
        window.document.getElementById('lyrics-plus-container')?.classList.remove('user-scrolling', 'not-focused');
        if (renderer.currentPrimaryActiveLine) renderer._scrollToActiveLine(renderer.currentPrimaryActiveLine, true);
        setNeedsFollow(false);
      }}>↳ FOLLOW LYRICS</button>}
    </div>
  );
}
