// Read-only, exact-ID facts for already verified mixer starts and historical projections.
// Never use title/artist fuzzy matching. Missing analysis is absent, not zero.
import * as db from '../../music/library-db.js';
import * as subsonic from '../../music/subsonic.js';
import { resolveEraYear } from '../../music/era-year.js';

export interface VerifiedMusicFacts {
  title?: string;
  artist?: string;
  year?: number;
  genre?: string;
  moods?: string[];
  energy?: 'low' | 'medium' | 'high';
  bpm?: number;
  key?: string;
  pace?: number;
}
const clean = (v: unknown, n = 100): string | undefined =>
  typeof v === 'string' ? (v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, n) || undefined) : undefined;
const validEnergy = (v: unknown): VerifiedMusicFacts['energy'] =>
  v === 'low' || v === 'medium' || v === 'high' ? v : undefined;
const validMoods = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const values = v.slice(0, 8).map(x => clean(x, 40)).filter((s): s is string => !!s);
  return values.length ? values : undefined;
};
const validNumber = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;

export function verifiedAirplayFacts(
  trackId: string | null | undefined,
  fallback: any = null,
  lookup: (id: string) => any = db.getVerifiedAirplayTrackLite,
): VerifiedMusicFacts | null {
  if (typeof trackId !== 'string' || !trackId || trackId.length > 256) return null;
  let record: any = null;
  try { record = lookup(trackId); } catch { /* optional metadata must not affect playback */ }
  const source = record && typeof record === 'object' ? record : null;
  // Fallback is explicitly supplied by the verified-start caller for this exact id.
  // No fallback ID matching is attempted here.
  const era = resolveEraYear(
    source?.year ?? fallback?.year,
    source?.originalYear ?? fallback?.originalYear,
    source?.yearUntrusted ?? fallback?.yearUntrusted ?? source?.isCompilation ?? fallback?.isCompilation,
  );
  let genre: string | undefined;
  try {
    genre = clean(subsonic.songGenres(source).join(', ') || subsonic.songGenres(fallback).join(', '), 180);
  } catch { genre = clean(source?.genre ?? fallback?.genre, 180); }
  const bpm = validNumber(source?.bpm, 0.001, 399.999) ?? validNumber(fallback?.bpm, 0.001, 399.999);
  const key = clean(source?.musicalKey ?? source?.musical_key ?? fallback?.musicalKey, 24);
  return {
    ...(clean(source?.title ?? fallback?.title) ? { title: clean(source?.title ?? fallback?.title) } : {}),
    ...(clean(source?.artist ?? fallback?.artist) ? { artist: clean(source?.artist ?? fallback?.artist) } : {}),
    ...(era !== null ? { year: era } : {}),
    ...(genre ? { genre } : {}),
    ...(validMoods(source?.moods) ?? validMoods(fallback?.moods) ? { moods: validMoods(source?.moods) ?? validMoods(fallback?.moods) } : {}),
    ...(validEnergy(source?.energy) ?? validEnergy(fallback?.energy) ? { energy: validEnergy(source?.energy) ?? validEnergy(fallback?.energy) } : {}),
    ...(bpm !== undefined ? { bpm } : {}),
    ...(key ? { key } : {}),
    ...(validNumber(source?.paceMean ?? fallback?.paceMean, 0, 1) !== undefined
      ? { pace: validNumber(source?.paceMean ?? fallback?.paceMean, 0, 1) } : {}),
  };
}

/** Strict identity boundary. Never look up acoustic/editorial metadata from a
 * title match, a missing mixer ID or a coincidentally equal queue position. */
export function verifiedMixerStartFacts(
  mixerTrackId: unknown, queuedTrack: any,
  lookup: (id: string) => any = db.getVerifiedAirplayTrackLite,
): VerifiedMusicFacts | null {
  if (typeof mixerTrackId !== 'string' || !mixerTrackId || queuedTrack?.id !== mixerTrackId) return null;
  return verifiedAirplayFacts(mixerTrackId, queuedTrack, lookup);
}
