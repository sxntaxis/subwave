// MI v3: source-grounded editorial evidence. This is a READ-ONLY briefing,
// never a discovery/eligibility authority and never a speculative airplay feed.
import * as library from '../../music/library.js';
import * as blocklist from '../../music/blocklist.js';
import * as settings from '../../settings.js';
import { applyStrictLocks } from '../../music/show-filter.js';
import { resolveEraYear } from '../../music/era-year.js';
import { applyTrackFloor } from '../../music/track-floor.js';
import { resolveExcludedPlaylistIds, resolveShowPlaylistPool } from '../../music/show-playlist.js';
import { getEssentiaReader, type EssentiaReader } from '../../music/essentia-evidence.js';
import { readVerifiedModelProfiles } from '../../music/music-evidence-reader.js';
import { maximalMusicEvidence } from '../../music/music-evidence-profile.js';
import type { VerifiedAirplayContext } from './verified-airplay-context.js';

const MAX_HISTORY = 12;
const MAX_CATALOGUE = 12;

/** The same verified acoustic evidence and trajectory status passed to the LLM. */
export function directorV3EvidenceForPrompt(
  evidence: {
    verifiedHistory: unknown[];
    candidatePalette: unknown[];
    coverage: unknown;
    meaning: string;
  },
  acoustic: unknown,
) {
  return {
    verifiedRecent: evidence.verifiedHistory,
    cataloguePalette: evidence.candidatePalette,
    evidenceCoverage: evidence.coverage,
    evidenceMeaning: evidence.meaning,
    acoustic: acoustic ?? {
      status: 'unavailable',
      note: 'No verified acoustic observation available; never infer completion.',
    },
  };
}

// Remote playlist resolution is useful context, never permission to delay a
// separate editorial decision indefinitely. Pending reads remain optional.
async function optionalRead<T>(request: Promise<T>, timeoutMs = 3500): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    })]);
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
}

const clean = (v: unknown, max = 100): string | undefined =>
  typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) || undefined : undefined;

/** Deterministic rotating coverage of an already filtered cohort. No first-N
 * bias, no track ID leaves this module, no claim of future queue admission. */
export function chooseDirectorCatalogueSample<T extends { id?: string; artist?: string | null;
  moods?: string[] | null; energy?: string | null; genres?: string[] | null }>(
  tracks: readonly T[], show: { moods?: string[]; energies?: string[]; genres?: string[] } | null,
  exclude: ReadonlySet<string>, epoch: number, cap = MAX_CATALOGUE,
): T[] {
  const hash = (s: string) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  };
  const seed = Math.floor(epoch / (15 * 60_000));
  const wantedMoods = new Set((show?.moods ?? []).map(x => x.toLowerCase()));
  const wantedGenres = new Set((show?.genres ?? []).map(x => x.toLowerCase()));
  const wantedEnergy = new Set(show?.energies ?? []);
  const ranked = tracks.filter(t => !!t?.id && !exclude.has(t.id!)).map(t => ({
    track: t,
    preferred: Number(
      (t.moods ?? []).some(x => wantedMoods.has(String(x).toLowerCase()))
      || (t.genres ?? []).some(x => wantedGenres.has(String(x).toLowerCase()))
      || (t.energy != null && wantedEnergy.has(t.energy))
    ),
    shuffle: hash(`${seed}:${t.id}`),
  })).sort((a, b) => b.preferred - a.preferred || a.shuffle - b.shuffle ||
    (a.track.id ?? '').localeCompare(b.track.id ?? ''));
  const chosen: T[] = [];
  const artists = new Set<string>();
  for (const { track } of ranked) {
    const artist = clean(track.artist)?.toLowerCase();
    if (artist && artists.has(artist)) continue;
    chosen.push(track);
    if (artist) artists.add(artist);
    if (chosen.length >= cap) return chosen;
  }
  for (const { track } of ranked) {
    if (chosen.some(t => t.id === track.id)) continue;
    chosen.push(track);
    if (chosen.length >= cap) break;
  }
  return chosen;
}

function candidateFacts(t: any, index: number) {
  let rec: any = null;
  let rich: any = null;
  let mix: { bpm: number | null; key: string | null; keyStart?: string | null; keyEnd?: string | null } | null = null;
  try { rec = library.getPlaybackMeta(t.id); } catch {}
  try { rich = library.get(t.id); } catch {}
  try { mix = library.bpmKeyFor(t); } catch {}
  const vocalRanges = Array.isArray(t.vocalRanges) ? t.vocalRanges : rich?.vocalRanges;
  const instrumental = Array.isArray(vocalRanges) ? vocalRanges.length === 0 : null;
  return {
    catalogueRef: `C${index + 1}`,
    title: clean(t.title, 120), artist: clean(t.artist), album: clean(t.album),
    year: resolveEraYear(t.year ?? rec?.year, t.originalYear ?? rec?.originalYear,
      t.yearUntrusted ?? rec?.yearUntrusted ?? t.isCompilation ?? rec?.isCompilation) ?? undefined,
    genres: (Array.isArray(t.genres) ? t.genres : Array.isArray(rec?.genres) ? rec.genres : [])
      .slice(0, 12).map((x: any) => clean(typeof x === 'string' ? x : x?.name, 60)).filter(Boolean),
    moods: (Array.isArray(t.moods) ? t.moods : Array.isArray(rec?.moods) ? rec.moods : []).slice(0, 12).map((x: unknown) => clean(x, 50)).filter(Boolean),
    energy: t.energy ?? rec?.energy ?? undefined,
    bpm: mix?.bpm ?? rec?.bpm ?? undefined,
    key: mix?.key ?? rec?.musicalKey ?? undefined,
    keyStart: mix?.keyStart ?? undefined, keyEnd: mix?.keyEnd ?? undefined,
    pace: rich?.paceMean ?? rec?.paceMean ?? undefined,
    audioMoods: (Array.isArray(rich?.audioMoods) ? rich.audioMoods : []).slice(0, 12)
      .map((x: unknown) => clean(x, 60)).filter(Boolean),
    lastfmTags: (Array.isArray(rich?.lastfmTags) ? rich.lastfmTags : []).slice(0, 24)
      .map((x: unknown) => clean(x, 60)).filter(Boolean),
    sectionCount: rich ? library.sectionCount(rich) ?? undefined : undefined,
    introMs: rich?.introMs ?? undefined,
    loudnessLufs: rich?.loudnessLufs ?? undefined,
    peakDb: rich?.peakDb ?? undefined,
    durationSeconds: t.durationSec ?? t.duration ?? rec?.duration_sec ?? undefined,
    ...(instrumental !== null ? { instrumental } : {}),
  };
}

/** This call runs only in independent Director work, never on the pick/mixer
 * critical path. Read the full in-memory catalog index, not audio files. */
export async function buildDirectorEvidence(
  show: any, verified: VerifiedAirplayContext, at: number,
  reader: EssentiaReader | null = getEssentiaReader(),
) {
  let tracks: any[] = [];
  let origin: 'playlist_union' | 'playlist_and_library_index' | 'library_index' | 'unavailable' = 'unavailable';
  let playlistStatus: 'not_configured' | 'resolved' | 'unavailable' = 'not_configured';
  if (show?.playlistIds?.length) {
    try {
      const pool = await optionalRead(resolveShowPlaylistPool(show));
      if (pool) { tracks = pool.tracks; origin = 'playlist_union'; playlistStatus = 'resolved'; }
      else playlistStatus = 'unavailable';
    } catch { playlistStatus = 'unavailable'; }
  }
  if (!show?.playlistStrict || !show?.playlistIds?.length) {
    try {
      const local = library.candidateFilterTracks();
      if (tracks.length) {
        // Soft playlists are not the entire show. Preserve both the pinned
        // anchors and wider library palette; never redefine show eligibility.
        tracks = [...chooseDirectorCatalogueSample(tracks, show, new Set(), at, 24), ...local];
        origin = 'playlist_and_library_index';
      } else { tracks = local; origin = 'library_index'; }
    } catch { if (!tracks.length) origin = 'unavailable'; }
  }
  let excluded: Set<string> | null = null;
  try { excluded = await optionalRead(resolveExcludedPlaylistIds(show)); }
  catch { /* preview stays non-authoritative */ }
  const historyIds = new Set(verified.details.map(h => h.trackId).filter((id): id is string => !!id));
  const withoutBlocked = blocklist.rejectBlocked(tracks).filter(t => t?.id && !excluded?.has(t.id));
  const constrained = show?.filtersStrict ? applyStrictLocks(withoutBlocked, {
    genres: show.genres ?? [], eras: show.eras ?? [], moods: show.moods ?? [],
    energies: show.energies ?? [], vocals: show.vocals || '',
  }, { starve: true }) : withoutBlocked;
  const floor = applyTrackFloor(constrained, settings.effectiveMinTrackSec(show), { starve: true });
  // Rehydrate the small preview before final blocklist/musical-rule checks:
  // the broad catalogue index intentionally omits album identity and structure.
  const preview = chooseDirectorCatalogueSample(floor, show, historyIds, at, 48)
    .map(t => { try { return library.slimById(t.id) ?? t; } catch { return t; } });
  const safe = blocklist.rejectBlocked(preview).filter(t => !excluded?.has(t.id));
  const strictSafe = show?.filtersStrict ? applyStrictLocks(safe, {
    genres: show.genres ?? [], eras: show.eras ?? [], moods: show.moods ?? [],
    energies: show.energies ?? [], vocals: show.vocals || '',
  }, { starve: true }) : safe;
  const selected = applyTrackFloor(strictSafe, settings.effectiveMinTrackSec(show), { starve: true })
    .slice(0, MAX_CATALOGUE);
  // Retain prior-show starts as history with their explicit showScope; only
  // the separate trajectory inspector restricts its window to this movement.
  const recent = verified.details.filter(h => h.trackId).slice(0, MAX_HISTORY);
  const evidence = await readVerifiedModelProfiles([
    ...recent.map(h => h.trackId!), ...selected.map(t => t.id),
  ], reader);
  const profile = (id: string): { status: 'verified' | 'missing'; data: ReturnType<typeof maximalMusicEvidence> | null } => {
    const row = evidence.profiles.get(id);
    return row ? { status: 'verified', data: maximalMusicEvidence(row) } : { status: 'missing', data: null };
  };
  return {
    source: 'read_only_verified_airplay_and_library_preview',
    coverage: { lookup: evidence.status, missingOrUnavailableIds: recent.length + selected.length -
        [...recent.map(h => h.trackId!), ...selected.map(t => t.id)].filter(id => evidence.profiles.has(id)).length,
      historyStarts: recent.length, catalogueSampled: selected.length,
      catalogueFilteredCount: floor.length, catalogueOrigin: origin, playlistStatus },
    lookupFailures: evidence.failures,
    meaning: 'Native, uncalibrated sparse Essentia windows; absence is unknown, not a zero. Catalogue samples are NOT reservations, guaranteed eligibility, or verified airplay.',
    verifiedHistory: recent.map(h => ({ ...h.entry, acoustic: profile(h.trackId!) })),
    candidatePalette: selected.map((track, i) => ({ ...candidateFacts(track, i), acoustic: profile(track.id) })),
  };
}
