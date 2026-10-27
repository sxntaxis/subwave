'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useStationClient } from '@/lib/stationClient';
import { fmtClockMinute, normalizeStationLocale } from '@/lib/format';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import type { SchedulePayload } from '@/lib/types';
import { DAY_NAMES, WEEK_DAYS, liveTakeover, programmeClock, programmeDay, programmeHour, type ProgrammeBlock } from './scheduleModel';
import styles from './ScheduleModal.module.css';

interface ScheduleModalProps {
  id: string;
  container: HTMLElement | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  stationName: string;
  showName: string;
  hostName: string;
  timezone: string | null;
}

function WeekBlock({ block, current, locale, expanded, onToggle }: { block: ProgrammeBlock; current: boolean; locale: 'en-GB' | 'en-US'; expanded: boolean; onToggle: () => void }) {
  const ref = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [descriptionFit, setDescriptionFit] = useState(false);
  const [naturalDescriptionHeight, setNaturalDescriptionHeight] = useState(0);
  const [naturalContentHeight, setNaturalContentHeight] = useState(0);
  const [previewLines, setPreviewLines] = useState(1);
  const [breathingSpace, setBreathingSpace] = useState(0);
  useDynamicStyle(ref, { '--slot-start': block.start + 1, '--slot-span': block.end - block.start });
  useDynamicStyle(contentRef, {
    '--expanded-description-height': `${naturalDescriptionHeight}px`,
    '--expanded-breathing-space': `${expanded && !descriptionFit ? Math.min(10, naturalContentHeight * .08) : descriptionFit ? breathingSpace : 0}px`,
  });
  useDynamicStyle(descriptionRef, { '--preview-lines': previewLines });
  const range = `${programmeHour(block.start, locale)} – ${programmeHour(block.end, locale)}`;
  const description = block.show?.topic?.trim();
  useLayoutEffect(() => {
    const card = ref.current;
    const content = contentRef.current;
    const measure = measureRef.current;
    if (!card || !content || !measure || !description) return;
    const update = () => {
      const visibleDescription = descriptionRef.current;
      const visibleWidth = visibleDescription?.getBoundingClientRect().width ?? 0;
      if (visibleWidth > 0 && Math.abs(measure.getBoundingClientRect().width - visibleWidth) > .5) measure.style.width = `${visibleWidth}px`;
      const fullHeight = measure.getBoundingClientRect().height;
      const shownHeight = visibleDescription?.getBoundingClientRect().height ?? 0;
      const currentPadding = Number.parseFloat(getComputedStyle(content).paddingBottom) || 0;
      const contentHeight = content.getBoundingClientRect().height - shownHeight - currentPadding + fullHeight;
      const grid = card.parentElement?.parentElement;
      const hourHeight = Number.parseFloat(grid ? getComputedStyle(grid).getPropertyValue('--hour-height') : '') || 124;
      const style = getComputedStyle(card);
      const baseTrackHeight = (block.end - block.start) * hourHeight;
      const availableHeight = Math.max(0, baseTrackHeight - (Number.parseFloat(style.paddingTop) || 0) - (Number.parseFloat(style.paddingBottom) || 0) - (Number.parseFloat(style.borderTopWidth) || 0) - (Number.parseFloat(style.borderBottomWidth) || 0));
      const otherContentHeight = contentHeight - fullHeight;
      const descriptionCapacity = Math.max(0, availableHeight - otherContentHeight);
      const lineHeight = Number.parseFloat(visibleDescription ? getComputedStyle(visibleDescription).lineHeight : '') || 18;
      const fits = contentHeight <= availableHeight + .5;
      const lines = Math.max(1, Math.floor(descriptionCapacity / lineHeight));
      const spareHeight = Math.max(0, availableHeight - contentHeight);
      const desiredBreathingSpace = Math.min(10, contentHeight * .08, spareHeight);
      setNaturalDescriptionHeight(previous => Math.abs(previous - fullHeight) < .5 ? previous : fullHeight);
      setNaturalContentHeight(previous => Math.abs(previous - contentHeight) < .5 ? previous : contentHeight);
      setPreviewLines(previous => previous === lines ? previous : lines);
      setBreathingSpace(previous => Math.abs(previous - desiredBreathingSpace) < .5 ? previous : desiredBreathingSpace);
      setDescriptionFit(previous => previous === fits ? previous : fits);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(card);
    observer.observe(content);
    if (descriptionRef.current) observer.observe(descriptionRef.current);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [block.end, block.start, description]);
  const isExpanded = expanded && !descriptionFit;
  const canToggle = !!description && !descriptionFit;
  return (
    <article
      ref={ref}
      className={styles.weekBlock}
      data-schedule-block={`${block.day}:${block.start}`}
      data-current={current || undefined}
      data-expanded={isExpanded || undefined}
      data-auto-description={descriptionFit || undefined}
      data-expandable={canToggle || undefined}
      aria-label={`${block.name}, ${range}${current ? ', on now' : ''}`}
      role={canToggle ? 'button' : undefined}
      tabIndex={canToggle ? 0 : undefined}
      aria-expanded={canToggle ? isExpanded : undefined}
      onClick={canToggle ? onToggle : undefined}
      onKeyDown={canToggle ? event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(); }
      } : undefined}
    >
      <div ref={contentRef} className={styles.blockContent}>
        <span className={styles.blockTime}>{range}</span>
        <h3>{block.name}</h3>
        {description && <>
          <p ref={descriptionRef} className={styles.blockDescription} data-fit={descriptionFit || undefined} data-expanded={isExpanded || undefined}>{description}</p>
          <span ref={measureRef} className={styles.blockDescriptionMeasure} aria-hidden="true">{description}</span>
        </>}
      </div>
    </article>
  );
}

function HourRail({ currentHour, locale }: { currentHour: number; locale: 'en-GB' | 'en-US' }) {
  return <div className={styles.hours} data-hour-rail aria-hidden="true">{Array.from({ length: 24 }, (_, hour) => <span key={hour} data-hour={hour} data-current-hour={currentHour === hour || undefined}><i /><b>{programmeHour(hour, locale)}</b></span>)}</div>;
}

function TimeMarker({ hour, minute, label }: { hour: number; minute: number; label: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [gap, setGap] = useState<{ start: number; end: number } | null>(null);
  const [position, setPosition] = useState(0);
  const [path, setPath] = useState('');
  useDynamicStyle(ref, {
    '--current-position': `${position}px`,
    '--label-gap-start': gap ? `${gap.start}px` : null,
    '--label-gap-end': gap ? `${gap.end}px` : null,
  });
  useLayoutEffect(() => {
    const marker = ref.current;
    const grid = marker?.parentElement;
    if (!marker || !grid) return;
    const labels = [...grid.querySelectorAll<HTMLElement>('[data-hour-rail] b')];
    const measure = () => {
      if (!grid.clientWidth) { setGap(null); return; }
      const hourMarker = grid.querySelector<HTMLElement>(`[data-hour-rail] [data-hour="${hour}"]`);
      if (!hourMarker) return;
      const row = hourMarker.getBoundingClientRect();
      const target = row.top + row.height * minute / 60 + 1.5;
      const line = marker.getBoundingClientRect();
      // One straight rule: snap the entire line to the nearest gap clear across
      // every day. Readability deliberately takes precedence over minute precision.
      const bands: { top: number; bottom: number }[] = [];
      for (const section of grid.querySelectorAll('section')) {
        for (const text of section.querySelectorAll<HTMLElement>('h3, p, [class*="blockTime"]')) {
          const clip = text.getBoundingClientRect();
          if (clip.bottom < target - 64 || clip.top > target + 64) continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          for (const rect of range.getClientRects()) {
            if (rect.top >= clip.bottom || rect.bottom <= clip.top) continue;
            bands.push({ top: rect.top - 1, bottom: rect.bottom + 1 });
          }
        }
      }
      const clear = (y: number) => bands.every(band => y < band.top || y > band.bottom);
      const candidates = [target, ...bands.flatMap(band => [band.top - .5, band.bottom + .5])];
      const y = candidates.filter(clear).sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0] ?? target;
      const nextPosition = y - grid.getBoundingClientRect().top - 1.5;
      setPosition(previous => Math.abs(previous - nextPosition) < .25 ? previous : nextPosition);
      const overlapping = labels.find(node => {
        const bounds = node.getBoundingClientRect();
        return y + .5 >= bounds.top && y - .5 <= bounds.bottom;
      });
      const bounds = overlapping?.getBoundingClientRect();
      const nextPath = bounds
        ? `M0 .5 H${Math.max(0, bounds.left - line.left - 1)} M${bounds.right - line.left + 1} .5 H${line.width}`
        : `M0 .5 H${line.width}`;
      setPath(previous => previous === nextPath ? previous : nextPath);
      if (!overlapping) { setGap(null); return; }
      const labelBounds = overlapping.getBoundingClientRect();
      const next = { start: Math.max(0, labelBounds.left - line.left - 1), end: Math.min(line.width, labelBounds.right - line.left + 1) };
      setGap(previous => previous && Math.abs(previous.start - next.start) < .5 && Math.abs(previous.end - next.end) < .5 ? previous : next);
    };
    let frame = 0;
    const refresh = () => {
      measure();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    refresh();
    const observer = new ResizeObserver(refresh);
    observer.observe(grid);
    labels.forEach(node => observer.observe(node));
    grid.querySelectorAll('article, h3, p').forEach(node => observer.observe(node));
    const scroller = grid.parentElement;
    scroller?.addEventListener('scroll', refresh, { passive: true });
    document.fonts?.addEventListener('loadingdone', refresh);
    // Sticky copy can move without a resize (including font/layout settling).
    // Keep the open modal's route fresh even when no observer edge is emitted.
    const settle = window.setInterval(measure, 250);
    return () => { clearInterval(settle); cancelAnimationFrame(frame); observer.disconnect(); scroller?.removeEventListener('scroll', refresh); document.fonts?.removeEventListener('loadingdone', refresh); };
  }, [hour, minute, position]);
  return <div ref={ref} className={styles.timeMarker} data-time-marker data-label-overlap={gap ? true : undefined} aria-label={label}><svg className={styles.timeRule} aria-hidden="true"><path d={path} /></svg></div>;
}

export default function ScheduleModal({ id, container, triggerRef, onClose, stationName, showName, hostName, timezone: fallbackTimezone }: ScheduleModalProps) {
  const client = useStationClient();
  const [data, setData] = useState<SchedulePayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [pickedDay, setPickedDay] = useState<number | null>(null);
  const [revealVersion, setRevealVersion] = useState(0);
  const [expandedBlock, setExpandedBlock] = useState<string | null>(null);
  const dayScrollRef = useRef<HTMLDivElement | null>(null);
  const weekScrollRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      const deadline = window.setTimeout(() => controller?.abort(), 10_000);
      try {
        const result = await client.schedule({ signal: controller.signal });
        if (!Array.isArray(result.shows) || !Array.isArray(result.personas) || !result.schedule) throw new Error('Invalid schedule');
        if (!stopped) { setData(result); setFailed(false); setNow(new Date()); }
      } catch {
        if (!stopped) setFailed(true);
      } finally { clearTimeout(deadline); inFlight = false; }
    };
    void refresh();
    const poll = window.setInterval(() => { void refresh(); setNow(new Date()); }, 30_000);
    return () => { stopped = true; clearInterval(poll); controller?.abort(); };
  }, [client, retry]);

  const timezone = data?.timezone ?? fallbackTimezone;
  const locale = normalizeStationLocale(data?.locale);
  const clock = programmeClock(now, timezone);
  const selectedDay = pickedDay ?? clock.day;
  const week = useMemo(() => data ? WEEK_DAYS.map(day => ({ day, blocks: programmeDay(data, day) })) : [], [data]);
  const dayBlocks = week.find(day => day.day === selectedDay)?.blocks ?? [];
  const currentBlock = week.find(day => day.day === clock.day)?.blocks.find(block => block.start <= clock.hour && block.end > clock.hour);
  const takeover = data ? liveTakeover(data, now.getTime()) : null;
  const takeoverShow = takeover?.showId ? data?.shows.find(show => show.id === takeover.showId) ?? null : null;
  const takeoverHost = takeoverShow
    ? [takeoverShow.personaId, ...takeoverShow.guestPersonaIds ?? []]
      .map(id => data?.personas.find(person => person.id === id)?.name)
      .filter(Boolean).join(' + ')
    : '';
  const liveTitle = takeover
    ? takeoverShow?.name ?? 'Default programming'
    : showName || currentBlock?.name || 'Freeform';
  const liveHost = takeover ? takeoverHost : hostName;
  const until = takeover ? fmtClockMinute(takeover.expiresAt, timezone, locale) : currentBlock ? programmeHour(currentBlock.end, locale) : '';

  const toggleBlock = (block: ProgrammeBlock) => {
    const key = `${block.day}:${block.start}`;
    setExpandedBlock(previous => previous === key ? null : key);
  };

  // Keep the active area in view on first load and when the panel changes
  // orientation. Day selection survives a rotation; the weekly view stays whole.
  const scheduleReady = data != null;
  useEffect(() => {
    if (!scheduleReady) return;
    const panel = panelRef.current;
    if (!panel) return;
    let previousPortrait: boolean | null = null;
    const reveal = () => {
      const portrait = panel.clientHeight >= panel.clientWidth;
      const scroller = portrait ? dayScrollRef.current : weekScrollRef.current;
      const target = scroller?.querySelector<HTMLElement>('[data-time-marker]');
      if (!scroller) return;
      if (!target) { if (portrait) scroller.scrollTop = 0; return; }
      scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientHeight * .3;
    };
    const frame = requestAnimationFrame(reveal);
    const observer = new ResizeObserver(() => {
      const portrait = panel.clientHeight >= panel.clientWidth;
      if (portrait !== previousPortrait) { previousPortrait = portrait; reveal(); }
    });
    observer.observe(panel);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [scheduleReady, selectedDay, revealVersion]);

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          ref={panelRef}
          id={id}
          className={styles.panel}
          data-locale={locale}
          aria-describedby={undefined}
          onOpenAutoFocus={event => { event.preventDefault(); closeRef.current?.focus(); }}
          onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus(); }}
        >
          <header className={styles.header}>
            <div className={styles.heading}>
              <div className={styles.eyebrow}>{stationName} · Programme</div>
              <Dialog.Title className={styles.title}>Schedule</Dialog.Title>
            </div>
            <div className={styles.liveStrip}>
              <span className={styles.liveTag}>NOW PLAYING</span>
              <div className={styles.liveIdentity}>
                <strong>{liveTitle}</strong>
                {(liveHost || until) && <span>{[liveHost, until ? `Until ${until}` : ''].filter(Boolean).join(' · ')}</span>}
              </div>
            </div>
            <Dialog.Close ref={closeRef} className={styles.closeAction} aria-label="Close schedule" title="Close schedule">
              <span aria-hidden="true">{ '\uF00D' }</span>
            </Dialog.Close>
          </header>

          {!data ? (
            <div className={styles.empty} role="status">
              <p>{failed ? 'The schedule could not be loaded.' : 'Loading schedule…'}</p>
              {failed && <button type="button" className={styles.action} onClick={() => setRetry(value => value + 1)}>TRY AGAIN</button>}
            </div>
          ) : (
            <div className={styles.programme}>
              {takeover && <p className={styles.takeover}>Live takeover until {until}. The regular weekly programme is shown below.</p>}
              <div className={styles.dayView}>
                <nav className={styles.days} aria-label="Choose schedule day">
                  {WEEK_DAYS.map(day => (
                    <button key={day} type="button" className={styles.dayChoice} aria-pressed={selectedDay === day} aria-label={`${DAY_NAMES[day]}${day === clock.day ? ', today' : ''}`} onClick={() => { setPickedDay(day); setExpandedBlock(null); }}>
                      {DAY_NAMES[day]?.slice(0, 3)}
                    </button>
                  ))}
                </nav>
                <div className={styles.dayHeading}>
                  <h2>{DAY_NAMES[selectedDay]}</h2>
                  <button type="button" className={styles.action} onClick={() => { setPickedDay(null); setRevealVersion(value => value + 1); }}>TODAY</button>
                </div>
                <div ref={dayScrollRef} className={styles.dayScroll} data-expanded={expandedBlock != null || undefined}>
                  <div className={`${styles.weekGrid} ${styles.portraitGrid}`}>
                    <HourRail currentHour={selectedDay === clock.day ? clock.hour : -1} locale={locale} />
                    <section className={styles.weekDay} aria-label={`${DAY_NAMES[selectedDay]} schedule`}>
                      {dayBlocks.map(block => <WeekBlock key={block.start} block={block} current={!takeover && selectedDay === clock.day && block.start <= clock.hour && clock.hour < block.end} locale={locale} expanded={expandedBlock === `${block.day}:${block.start}`} onToggle={() => toggleBlock(block)} />)}
                    </section>
                    {selectedDay === clock.day && <TimeMarker hour={clock.hour} minute={clock.minute} label={`Station time ${fmtClockMinute(now, timezone, locale)}`} />}
                  </div>
                </div>
              </div>

              <div className={styles.weekView}>
                <div className={styles.weekHead} aria-hidden="true">
                  <span />
                  {WEEK_DAYS.map(day => <div key={day} data-today={day === clock.day || undefined}>{DAY_NAMES[day]?.slice(0, 3)}</div>)}
                </div>
                <div ref={weekScrollRef} className={styles.weekScroll} data-expanded={expandedBlock != null || undefined}>
                  <div className={styles.weekGrid}>
                    <HourRail currentHour={clock.hour} locale={locale} />
                    {week.map(({ day, blocks }) => (
                      <section key={day} className={styles.weekDay} aria-label={`${DAY_NAMES[day]} schedule`} data-today={day === clock.day || undefined}>
                        {blocks.map(block => <WeekBlock key={block.start} block={block} current={!takeover && day === clock.day && block.start <= clock.hour && clock.hour < block.end} locale={locale} expanded={expandedBlock === `${block.day}:${block.start}`} onToggle={() => toggleBlock(block)} />)}
                      </section>
                    ))}
                    <TimeMarker hour={clock.hour} minute={clock.minute} label={`Station time ${fmtClockMinute(now, timezone, locale)}`} />
                  </div>
                </div>
              </div>
            </div>
          )}

        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
