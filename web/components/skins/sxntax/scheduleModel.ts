import { zonedDayHour } from '../../../lib/format';
import type { SchedulePayload, ScheduleShow, StationLocale } from '../../../lib/types';

export const WEEK_DAYS = [1, 2, 3, 4, 5, 6, 0];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface ProgrammeBlock {
  day: number;
  start: number;
  end: number; // exclusive; 24 is the end of this day, not another midnight row
  show: ScheduleShow | null;
  name: string;
  hosts: string;
}

export function programmeDay(data: SchedulePayload, day: number): ProgrammeBlock[] {
  const shows = new Map(data.shows.map(show => [show.id, show]));
  const people = new Map(data.personas.map(person => [person.id, person.name]));
  const grid = data.schedule[day] ?? [];
  const resolved = Array.from({ length: 24 }, (_, hour) => shows.get(grid[hour] ?? '') ?? null);
  const blocks: ProgrammeBlock[] = [];
  for (let start = 0; start < 24;) {
    const show = resolved[start] ?? null;
    let end = start + 1;
    while (end < 24 && resolved[end] === show) end++;
    const hosts = show
      ? [show.personaId, ...show.guestPersonaIds ?? []].map(id => people.get(id)).filter(Boolean).join(' + ')
      : '';
    blocks.push({ day, start, end, show, name: show?.name || 'Freeform', hosts });
    start = end;
  }
  return blocks;
}

export function programmeClock(now: Date, timezone?: string | null) {
  const { dow: day, hour } = zonedDayHour(now, timezone);
  let minute = now.getMinutes();
  if (timezone) {
    try { minute = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, minute: '2-digit' }).format(now)); } catch {}
  }
  return { day, hour, minute, minutes: hour * 60 + minute };
}

export function liveTakeover(data: SchedulePayload, now: number) {
  const override = data.override;
  if (!override || override.startedAt > now || override.expiresAt <= now) return null;
  if (override.showId != null && !data.shows.some(show => show.id === override.showId)) return null;
  return override;
}

export function programmeHour(hour: number, locale: StationLocale): string {
  if (locale === 'en-US') {
    const value = hour % 24;
    return `${value % 12 || 12}:00 ${value < 12 ? 'AM' : 'PM'}`;
  }
  return `${String(hour).padStart(2, '0')}:00`;
}
