'use client';

import { useEffect } from 'react';

// Service-worker setup is deliberately background work. A returning visitor is
// already controlled by the existing worker; a first visit gains nothing by
// competing with hydration/font/feed work for the first frame.
export default function ServiceWorkerRegister(): null {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    let timer: number | null = null;
    let idle: number | null = null;
    let cancelled = false;

    const run = () => {
      if (cancelled) return;
      if (process.env.NODE_ENV !== 'production') {
        navigator.serviceWorker
          .getRegistrations()
          .then((regs) => regs.forEach((r) => r.unregister()))
          .catch(() => {});
        if ('caches' in window) {
          caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
        }
        return;
      }

      if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') return;
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('[sw] registration failed:', err);
      });
    };

    if (typeof window.requestIdleCallback === 'function') {
      idle = window.requestIdleCallback(run, { timeout: 2500 });
    } else {
      timer = window.setTimeout(run, 1200);
    }

    return () => {
      cancelled = true;
      if (idle != null && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle);
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);
  return null;
}
