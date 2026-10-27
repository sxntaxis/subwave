'use client';

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { LyricsViewPhase } from './lyricsPresentation';
import { presentationHeight } from './presentationGeometry';

/** One reversible view envelope. Song semantics remain owned by the existing
 * track handoff; no CSS entry animation or timeout can resurrect an old song. */
export function useLyricsPresentation(
  root: RefObject<HTMLDivElement | null>, wanted: boolean, documentKey: string | null,
  lite: boolean, trackProgress: RefObject<number>, handoffActive: RefObject<boolean>, ready: boolean,
) {
  const position = useRef(0);
  const generation = useRef(0);
  const reveal = useRef<{key: string | null; started: number}>({key: null, started: 0});
  const [phase, setPhase] = useState<LyricsViewPhase>('artwork');
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const id = ++generation.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = reduced ? 0 : lite ? 240 : 580;
    const from = position.current, to = wanted ? 1 : 0, started = performance.now();
    if (reveal.current.key !== documentKey) reveal.current = {key: documentKey, started};
    let frame = 0;
    const stage = node.querySelector<HTMLElement>('[data-lyrics-ui-revision]');
    const scrollport = stage?.closest<HTMLElement>('[data-player-scrollport]');
    const heading = stage?.querySelector<HTMLElement>('[data-hero-heading]');
    const cluster = stage?.querySelector<HTMLElement>('[data-hero-now]');
    const artwork = stage?.querySelector<HTMLElement>('[data-artwork-surface]');
    const corridor = stage?.querySelector<HTMLElement>('[data-hero-now]')?.parentElement;
    const label = heading?.querySelector<HTMLElement>('[data-hero-live]');
    const compact = heading?.querySelector<HTMLElement>('[aria-label="Current song"]');
    const pending = stage?.querySelector<HTMLElement>('[data-lyrics-pending]');
    const transcript = stage?.querySelector<HTMLElement>('[data-lyric-key]');
    let normalHeight = 0;
    let availableHeight = 0;
    let normalHeading = 0;
    let compactHeading = 0;
    let identityGap = 12;
    const applyGeometry = (progress: number) => {
      if (!corridor || normalHeight <= 0 || (handoffActive.current && progress === 0)) return;
      const height = presentationHeight(normalHeading, compactHeading, progress);
      if (heading) heading.style.height = `${height}px`;
      if (cluster) cluster.style.gridTemplateRows = `${height}px minmax(0, 1fr)`;
      if (artwork) artwork.style.top = `${height + identityGap}px`;
      corridor.style.height = `${presentationHeight(normalHeight, availableHeight, progress)}px`;
    };
    const outerHeight = (selector: string) => {
      const element = stage?.querySelector<HTMLElement>(selector);
      if (!element) return 0;
      const css = getComputedStyle(element);
      return element.getBoundingClientRect().height + (parseFloat(css.marginTop) || 0) + (parseFloat(css.marginBottom) || 0);
    };
    const measureBudget = () => {
      if (!stage || !heading || !artwork) return;
      const css = getComputedStyle(stage);
      identityGap = parseFloat(css.getPropertyValue('--sx-label-gap')) || 12;
      const stationGap = parseFloat(css.getPropertyValue('--sx-station-song-gap')) || 26;
      const controlsGap = parseFloat(css.getPropertyValue('--sx-playback-controls-gap')) || 26;
      const padding = (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0);
      normalHeading = label?.offsetHeight || heading.offsetHeight;
      compactHeading = compact?.offsetHeight || normalHeading;
      normalHeight = normalHeading + identityGap + artwork.getBoundingClientRect().height;
      // Resolve the actual container instead of parsing the calc() CSS token.
      const usable = scrollport?.clientHeight || window.innerHeight;
      availableHeight = Math.max(compactHeading + identityGap + 120,
        usable - padding - stationGap - controlsGap - outerHeight('[data-hero-header]')
        - outerHeight('[data-hero-progress]') - outerHeight('[data-hero-facts]')
        - outerHeight('[data-hero-controls]'));
      applyGeometry(position.current);
    };
    const observer = new ResizeObserver(measureBudget);
    // Observe intrinsic inputs only, never the animated corridor or transcript.
    for (const selector of ['[data-artwork-surface]', '[data-hero-header]', '[data-hero-progress]', '[data-hero-facts]', '[data-hero-controls]']) {
      const element = stage?.querySelector(selector);
      if (element) observer.observe(element);
    }
    if (scrollport) observer.observe(scrollport);
    window.addEventListener('resize', measureBudget);
    window.visualViewport?.addEventListener('resize', measureBudget);
    measureBudget();
    setPhase(wanted ? 'opening' : 'closing');
    if (from !== to) node.setAttribute('data-sx-view-moving', 'true');
    node.setAttribute('data-lyrics-generation', String(id));
    // Before React paints a newly keyed document, its reveal starts here.
    const tick = (now: number) => {
      if (generation.current !== id) return;
      const elapsed = now - started;
      const step = duration ? elapsed / duration : 1;
      const p = to > from ? Math.min(to, from + step) : Math.max(to, from - step);
      position.current = p;
      applyGeometry(p);
      // Sequential transfer: the large identity is completely gone before
      // compact identity, transcript, or endcard can paint (and vice versa).
      const artworkOpacity = Math.max(0, 1 - p / .45);
      const projection = Math.max(0, (p - .55) / .45);
      const documentReveal = documentKey ? Math.min(1, duration ? (now - reveal.current.started) / Math.min(duration, 240) : 1) : 0;
      const semantic = handoffActive.current
        ? Math.max(0, Math.min(1, (trackProgress.current - .48) / .26)) : 1;
      if (artwork) artwork.style.opacity = String(artworkOpacity);
      if (compact) compact.style.opacity = String(projection);
      if (pending) pending.style.opacity = String(projection);
      if (transcript) transcript.style.opacity = String(projection * documentReveal * semantic);
      node.setAttribute('data-lyrics-progress', p.toFixed(4));
      if (p === to) {
        setPhase(wanted ? 'lyrics' : 'artwork');
        if (node.hasAttribute('data-sx-view-moving')) {
          node.removeAttribute('data-sx-view-moving');
          stage?.dispatchEvent(new Event('sxntax:presentation-settled'));
        }
      }
      // Keep reading the track coordinator only while it owns a handoff.
      if (p !== to || (documentKey && documentReveal < 1) || handoffActive.current) {
        frame = requestAnimationFrame(tick);
      }
    };
    tick(started);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', measureBudget);
      window.visualViewport?.removeEventListener('resize', measureBudget);
      node.removeAttribute('data-sx-view-moving');
    };
  }, [root, wanted, documentKey, lite, trackProgress, handoffActive, ready]);
  return { phase, mounted: wanted || phase !== 'artwork' };
}
