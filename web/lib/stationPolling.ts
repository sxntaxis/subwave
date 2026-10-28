export const STATION_FOREGROUND_POLL_MS = 5000;
export const STATION_BACKGROUND_POLL_MS = 15000;

export interface StationPollingEnvironment {
  hidden(): boolean;
  now(): number;
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
  visibility: EventTarget;
  foreground: EventTarget;
}

/** Metadata only: a hidden playing station keeps a low-rate feed, while
 * foreground return always revalidates because browsers may freeze timers.
 * No media element, view transition or rendering loop is managed here. */
export function pollStationFeed(
  tick: (reconcile: boolean) => void,
  isPlaying: () => boolean,
  environment: StationPollingEnvironment = {
    hidden: () => document.hidden,
    now: () => performance.now(),
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: timer => clearTimeout(timer),
    visibility: document,
    foreground: window,
  },
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let lastForegroundRefresh = -Infinity;
  const schedule = () => {
    if (timer !== null) environment.cancel(timer);
    timer = environment.schedule(regularTick, environment.hidden()
      ? STATION_BACKGROUND_POLL_MS : STATION_FOREGROUND_POLL_MS);
  };
  const regularTick = () => {
    if (stopped) return;
    timer = null;
    if (!environment.hidden() || isPlaying()) tick(environment.hidden());
    schedule();
  };
  const foreground = () => {
    if (stopped || environment.hidden()) return;
    const now = environment.now();
    // visibility/focus/pageshow often describe the same return. One fresh
    // request replaces the old one; do not abort/refetch it three times.
    if (now - lastForegroundRefresh < 250) return;
    lastForegroundRefresh = now;
    tick(true);
    schedule();
  };
  const visibility = () => {
    if (environment.hidden()) schedule();
    else foreground();
  };
  environment.visibility.addEventListener('visibilitychange', visibility);
  environment.visibility.addEventListener('resume', foreground);
  environment.foreground.addEventListener('focus', foreground);
  environment.foreground.addEventListener('pageshow', foreground);
  if (!environment.hidden() || isPlaying()) tick(environment.hidden());
  schedule();
  return () => {
    stopped = true;
    if (timer !== null) environment.cancel(timer);
    environment.visibility.removeEventListener('visibilitychange', visibility);
    environment.visibility.removeEventListener('resume', foreground);
    environment.foreground.removeEventListener('focus', foreground);
    environment.foreground.removeEventListener('pageshow', foreground);
  };
}
