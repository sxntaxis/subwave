// MI v2.4: bounded, deterministic evidence for long-form editorial direction.
// This module never reads the catalogue or creates playable candidates. It
// describes actual airplay, and leaves musical interpretation to the DJ.
export type ShowPhase = 'opening' | 'development' | 'closing' | 'unknown';
export type MovementDecision = 'continue' | 'resolve' | 'reroute';
export interface AirplayFootprint {
  eventId: string;
  showId: string | null;
  at: string;
  trackId: string | null;
  artist: string | null;
  energy: string | null;
  moods: string[];
  genre: string | null;
}
export interface DirectionDevelopment {
  decision: MovementDecision;
  next: string;
  alternate: string;
}
export interface MovementProgress {
  starts: number;
  elapsedMinutes: number;
  lastAt: string;
  lastTrackId: string | null;
  distinctArtists: number;
  phase: 'establishing' | 'developing' | 'resolving';
  alternate: string | null;
}
export interface ResolvedMovement {
  showId: string | null;
  movement: string;
  destination: string;
  outcome: 'resolved' | 'rerouted' | 'expired' | 'show-change' | 'human';
  endedAt: string;
  starts: number;
  followOn?: string;
  alternate?: string;
}
export interface EditorialMemory {
  recent: AirplayFootprint[];
  resolved: ResolvedMovement[];
}
export const emptyMemory = (): EditorialMemory => ({ recent: [], resolved: [] });
export const cleanShort = (value: unknown, limit: number): string | null =>
  typeof value === 'string' ? (value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) || null) : null;
export function rememberAirplay(memory: EditorialMemory, start: {
  eventId: string; showId: string | null; at: number; trackId: string | null;
  artist?: string | null; energy?: string | null; genre?: string | null; moods?: string[] | null;
}): EditorialMemory {
  if (!start.eventId || memory.recent.some(e => e.eventId === start.eventId)) return memory;
  const point: AirplayFootprint = {
    eventId: start.eventId.slice(0, 220), showId: start.showId,
    at: new Date(start.at).toISOString(), trackId: cleanShort(start.trackId, 100),
    artist: cleanShort(start.artist, 100), energy: cleanShort(start.energy, 30),
    genre: cleanShort(start.genre, 80),
    moods: (start.moods ?? []).filter(m => typeof m === 'string').slice(0, 6)
      .map(m => cleanShort(m, 40)).filter((m): m is string => !!m),
  };
  return { ...memory, recent: [point, ...memory.recent].slice(0, 48) };
}
export function resolveMemory(memory: EditorialMemory, item: ResolvedMovement): EditorialMemory {
  return { ...memory, resolved: [item, ...memory.resolved].slice(0, 12) };
}
export function musicalMemoryView(memory: EditorialMemory, showId: string | null) {
  const inShow = memory.recent.filter(e => e.showId === showId).slice(0, 12);
  const before = memory.recent.find(e => e.showId !== showId) ?? null;
  const artists = new Set(inShow.map(e => e.artist?.toLowerCase()).filter(Boolean));
  const energies = inShow.map(e => e.energy).filter(Boolean);
  // A descriptive signal from *catalogue energy bands*, not an inferred
  // Essentia trajectory. Missing tags cannot count as low energy or stability.
  const observed = inShow.slice(0, 6).reverse().map((e): number | null =>
    e.energy === 'low' ? 0 : e.energy === 'medium' ? 1 : e.energy === 'high' ? 2 : null
  ).filter((n): n is number => n !== null);
  const steps = observed.slice(1).map((n, i) => Math.sign(n - observed[i]));
  const rising = steps.filter(n => n > 0).length;
  const falling = steps.filter(n => n < 0).length;
  const taggedEnergyTrend = observed.length < 3 ? null
    : rising && falling ? 'mixed'
      : rising ? 'rising' : falling ? 'falling' : 'steady';
  const lastSix = inShow.slice(0, 6);
  const artistsLastSix = lastSix.map(e => e.artist?.toLowerCase()).filter((s): s is string => !!s);
  const artistConcentration = artistsLastSix.length < 5 ? null
    : new Set(artistsLastSix).size <= 2 ? 'concentrated' : 'varied';
  const moods = new Map<string, number>();
  for (const e of inShow) for (const m of e.moods) moods.set(m, (moods.get(m) || 0) + 1);
  return {
    showStarts: inShow.length, distinctArtists: artists.size,
    recentEnergies: energies.slice(0, 6), taggedEnergyTrend, artistConcentration,
    recurringMoods: [...moods].sort((a,b) => b[1]-a[1]).slice(0, 5).map(([m,count]) => ({ mood:m, count })),
    precedingShow: before ? { showId: before.showId, energy: before.energy, moods: before.moods } : null,
    recentMovements: memory.resolved.filter(e => e.showId === showId).slice(0, 4),
  };
}
export function progressAt(startedAt: string, at: number, starts: number, artists: number, trackId: string | null,
  alternate: string | null, horizonMin: number): MovementProgress {
  const elapsedMinutes = Math.max(0, Math.round((at - Date.parse(startedAt)) / 60_000));
  const phase = elapsedMinutes >= horizonMin * 0.8 ? 'resolving'
    : starts <= 1 ? 'establishing' : 'developing';
  return { starts, elapsedMinutes, lastAt: new Date(at).toISOString(), lastTrackId: trackId,
    distinctArtists: artists, phase, alternate };
}

// A show-phase descriptor is factual scheduling context, not a show-description
// profile or a new authority over the queue's existing hard boundary rules.
export function showPhaseInfo(nowMs: number, previousBoundaryMs: number | null,
  nextBoundaryMs: number | null) {
  const minutesRemaining = nextBoundaryMs == null ? null : Math.max(0, Math.round((nextBoundaryMs - nowMs) / 60_000));
  const minutesSinceChange = previousBoundaryMs == null ? null : Math.max(0, Math.round((nowMs - previousBoundaryMs) / 60_000));
  const phase: ShowPhase = minutesRemaining != null && minutesRemaining <= 12 ? 'closing'
    : minutesSinceChange != null && minutesSinceChange <= 12 ? 'opening'
    : minutesSinceChange != null || minutesRemaining != null ? 'development' : 'unknown';
  return { phase, minutesRemaining, minutesSinceChange };
}
