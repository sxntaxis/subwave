// One bounded, read-only factual view of actual starts for Agent, Pool and
// acoustic inspector. No queue items, listener text, tokens or raw event IDs
// appear in the model-facing projection.
import type { AirplayFootprint } from './music-director-v2-core.js';
import { verifiedAirplayFacts, type VerifiedMusicFacts } from './verified-airplay-facts.js';
const clean = (v: unknown, n = 100): string | undefined =>
  typeof v === 'string' ? (v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, n) || undefined) : undefined;

export interface VerifiedAirplayView extends VerifiedMusicFacts {
  historyRef: string;
  showScope: 'current' | 'previous' | 'unknown';
}
export interface VerifiedAirplayInternal {
  historyRef: string;
  eventId: string;
  trackId: string | null;
  showId: string | null;
  at: string;
  entry: VerifiedAirplayView;
}
export interface VerifiedAirplayContext {
  entries: VerifiedAirplayView[];
  details: VerifiedAirplayInternal[]; // private: NEVER serialize into model prompt
}
/** Present the now-playing record exactly once, when its identity AND start
 * timestamp match the already verified start. This is presentation-only: it
 * never authorizes a score, a queue pick or a reconstructed mixer event. */
export function poolVerifiedHistory(
  context: VerifiedAirplayContext,
  currentId: string | null | undefined,
  startedAt: string | null | undefined,
) {
  const first = context.details[0];
  const startedMs = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  const verifiedMs = first ? Date.parse(first.at) : NaN;
  const overlaps = !!first && !!first.trackId && first.trackId === currentId
    && Number.isFinite(startedMs) && Number.isFinite(verifiedMs)
    && Math.abs(startedMs - verifiedMs) <= 2000;
  return {
    recentPlays: overlaps ? context.entries.slice(1) : context.entries,
    currentHistoryRef: overlaps ? first.historyRef : undefined,
  };
}

export function projectVerifiedAirplay(
  recent: readonly AirplayFootprint[], currentShowId: string | null,
  lookup: (id: string, fallback: any) => VerifiedMusicFacts | null = (id, fallback) => verifiedAirplayFacts(id, fallback),
): VerifiedAirplayContext {
  const out: VerifiedAirplayInternal[] = [];
  const seenEvents = new Set<string>();
  for (const e of recent) {
    if (out.length >= 12) break;
    if (!e || typeof e.eventId !== 'string' || !e.eventId || seenEvents.has(e.eventId)
        || !Number.isFinite(Date.parse(e.at))) continue;
    seenEvents.add(e.eventId);
    const trackId = typeof e.trackId === 'string' && e.trackId ? e.trackId : null;
    let facts: VerifiedMusicFacts | null = null;
    if (trackId) try { facts = lookup(trackId, e); } catch { /* missing optional metadata */ }
    const historyRef = 'H' + (out.length + 1);
    const showScope = e.showId === null || currentShowId === null ? 'unknown'
      : e.showId === currentShowId ? 'current' : 'previous';
    // Persisted facts are valid fallback for older records whose exact ID no
    // longer has a library row; they are NOT a source of inferred title/year.
    const artist = facts?.artist ?? clean(e.artist);
    const genre = facts?.genre ?? clean(e.genre, 180);
    const persistedMoods = Array.isArray(e.moods)
      ? e.moods.slice(0, 8).map(m => clean(m, 40)).filter((m): m is string => !!m) : [];
    const moods = facts?.moods ?? persistedMoods;
    const energy = facts?.energy ?? (e.energy === 'low' || e.energy === 'medium' || e.energy === 'high' ? e.energy : undefined);
    const entry: VerifiedAirplayView = {
      historyRef, showScope,
      ...(facts?.title ? { title: facts.title } : {}),
      ...(artist ? { artist } : {}),
      ...(facts?.year != null ? { year: facts.year } : {}),
      ...(genre ? { genre } : {}),
      ...(moods.length ? { moods } : {}),
      ...(energy ? { energy } : {}),
      ...(facts?.bpm != null ? { bpm: facts.bpm } : {}),
      ...(facts?.key ? { key: facts.key } : {}),
      ...(facts?.pace != null ? { pace: facts.pace } : {}),
    };
    out.push({ historyRef, eventId:e.eventId, trackId, showId:e.showId, at:e.at, entry });
  }
  // Whole-record budget: no invalid partial JSON, no tokens or event-id leaks.
  while (out.length && Buffer.byteLength(JSON.stringify(out.map(x => x.entry)), 'utf8') > 4096) out.pop();
  return { entries: out.map(x => x.entry), details: out };
}
