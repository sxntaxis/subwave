'use client';

import { useLayoutEffect, useRef } from 'react';
import styles from './Sxntax.module.css';

export default function RadioFrame({ clock }: { clock: string }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pathRef = useRef<SVGPathElement | null>(null);
  const clockRef = useRef<SVGTextElement | null>(null);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    const path = pathRef.current;
    const clockEl = clockRef.current;
    const host = svg?.parentElement;
    if (!svg || !path || !clockEl || !host) return;

    let raf = 0;
    const render = () => {
      raf = 0;
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      const cs = getComputedStyle(host);
      const inset = Number.parseFloat(cs.getPropertyValue('--sx-frame-inset')) || 18;
      const stroke = Number.parseFloat(cs.getPropertyValue('--sx-frame-stroke')) || 1.3;
      const clockSize = Number.parseFloat(cs.getPropertyValue('--sx-frame-clock')) || 16;
      const half = stroke / 2;
      const x = inset + half;
      const y = inset + half;
      const right = w - inset - half;
      const bottom = h - inset - half;
      const radius = Math.max(7, Math.min(14, inset * 0.48));

      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      clockEl.setAttribute('x', String(w / 2));
      clockEl.setAttribute('y', String(y + 0.5));

      const hasClock = Boolean(clock.trim());
      const rawMeasured = hasClock ? (clockEl.getComputedTextLength?.() || 78) : 0;
      const measured = hasClock && Number.isFinite(rawMeasured)
        ? Math.min(Math.max(rawMeasured, clockSize * 4.2), Math.min(132, w * 0.22))
        : 0;
      const cx = w / 2;
      const gapLeft = cx - measured / 2;
      const gapRight = cx + measured / 2;

      path.setAttribute('d', [
        `M ${x + radius} ${y}`,
        hasClock ? `H ${gapLeft}` : `H ${right - radius}`,
        hasClock ? `M ${gapRight} ${y}` : '',
        hasClock ? `H ${right - radius}` : '',
        `Q ${right} ${y} ${right} ${y + radius}`,
        `V ${bottom - radius}`,
        `Q ${right} ${bottom} ${right - radius} ${bottom}`,
        `H ${x + radius}`,
        `Q ${x} ${bottom} ${x} ${bottom - radius}`,
        `V ${y + radius}`,
        `Q ${x} ${y} ${x + radius} ${y}`,
      ].join(' '));

    };

    const queue = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(render);
    };

    const observer = new ResizeObserver(queue);
    observer.observe(host);
    window.addEventListener('resize', queue, { passive: true });
    window.visualViewport?.addEventListener('resize', queue, { passive: true });
    queue();
    document.fonts?.ready.then(queue);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', queue);
      window.visualViewport?.removeEventListener('resize', queue);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [clock]);

  return (
    <svg
      ref={svgRef}
      className={styles.frame}
      aria-hidden="true"
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', color: 'var(--sx-fg, #feffff)', pointerEvents: 'none' }}
    >
      <path
        ref={pathRef}
        className={styles.framePath}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        vectorEffect="non-scaling-stroke"
      />
      <text
        ref={clockRef}
        className={styles.frameClock}
        fill="currentColor"
        opacity={clock ? 1 : 0}
        style={{ transition: 'opacity 180ms ease' }}
      >
        {clock}
      </text>
    </svg>
  );
}
