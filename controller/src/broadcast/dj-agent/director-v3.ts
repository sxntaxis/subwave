// MI v3 independent editorial Director. Non-blocking: the mixer/picker never
// waits for this LLM or its optional context readers. Read-only exploration;
// the only write is an event- and revision-fenced direction-store commit.
import * as settings from '../../settings.js';
import * as library from '../../music/library.js';
import { getFullContext } from '../../context.js';
import { resolveShowPlaylistPool, type PlaylistPool } from '../../music/show-playlist.js';
import { getPlaylistMusicFacts, sampledShowMusic } from './director-v3-pool.js';
import { fetchDirectorCulture } from './director-v3-research.js';
import { djObject } from '../../llm/sdk.js';
import { djCallsAllowed } from '../listeners.js';
import { currentMode } from '../dj-budget.js';
import { logEvent } from '../../observability/events.js';
import { incomingShowPhase } from './show-phase.js';
import { projectVerifiedAirplay } from './verified-airplay-context.js';
import { musicDirection, directorV3Enabled } from './music-direction.js';
import {
  directorV3Due, directorV3ModelResult, directorV3SeedSchema, directorV3ReviewSchema,
} from './director-v3-core.js';
import { inspectVerifiedTrajectory } from '../../music/trajectory-runtime.js';

export type DirectorV3Start = { eventId: string; trackId: string | null; showId: string | null;
  at: number; source: 'auto' | 'listener' | 'admin' };

const SYSTEM = `You are the independent editorial Music Director of a music-only freeform radio station.
You plan musical movements, not songs or schedules. You never control the queue, claim a
song was played unless its mixer start was verified, or rewrite show restrictions.
Prioritize, in order: human steering; active show's identity and hard constraints;
actual verified musical history; feasible catalogue material; temporal/weather/cultural mood.
A poetic destination is an artistic intention, NOT a numerically measurable outcome.
Measured acoustic trajectory is fallible evidence, not a musical quality score.
A future playlist is only a catalogue sample; it is NOT a guarantee of eligibility.
Do not treat web headlines as facts without independent confirmation, or use them to
violate a show. Do not mention or promise a particular song ID or future queued track.
Favor variety and coherent changes, not perpetual building or artificial crescendos.
Your answer must be concise and realistic within the remaining show time.`;

const MAX_MODEL_MS = 25_000;
let running = false;
let retryAfter = 0;
// One autonomous model run at a time per controller. A stale model response is
// discarded at the durable store; an error waits before another try.
export async function observeDirectorV3(start: DirectorV3Start): Promise<void> {
  if (!directorV3Enabled() || !start.trackId || start.source !== 'auto'
    || !djCallsAllowed() || currentMode() !== 'normal' || running || Date.now() < retryAfter) return;
  const snapshot = musicDirection.snapshot(start.showId);
  if (!snapshot) return;
  const phase = incomingShowPhase(new Date(start.at));
  const action = directorV3Due({ movement: snapshot.movement, steering: snapshot.steering,
    now: start.at, minutesToBoundary: phase.minutesRemaining,
    source: start.source, trackId: start.trackId });
  if (!action) return;
  const show = settings.resolveActiveShow(new Date(start.at));
  if ((show?.id ?? null) !== start.showId) return; // no stale session-show authority
  running = true;
  retryAfter = Date.now() + 60_000;
  const captured = { revision: snapshot.revision, movementId: snapshot.movement?.id ?? null,
    showSignature: JSON.stringify(briefShow(show)) };
  try {
    // The existing library-backed history projection omits listener text,
    // queue tokens, raw event IDs and other untrusted model-facing metadata.
    const recent = musicDirection.recentVerifiedAirplay();
    const verified = projectVerifiedAirplay(recent, start.showId);
    const context = await getFullContext(new Date(start.at), { cachedWeatherOnly: true });
    const nextShow = phase.minutesRemaining !== null && phase.minutesRemaining <= 60
      ? settings.resolveActiveShow(new Date(start.at + (phase.minutesRemaining + 1) * 60_000)) : null;
    const briefing = await transitionBrief(show, nextShow, phase.minutesRemaining);
    const acoustic = snapshot.movement && !snapshot.steering
      ? await inspectVerifiedTrajectory(start.showId,
        musicDirection.recentVerifiedStarts(start.showId, 8, snapshot.movement.startedAt),
        snapshot.movement.energy, snapshot.movement.startedAt) : null;
    const culture = action === 'seed' ? await fetchDirectorCulture() : [];
    const input = {
      action,
      show: briefShow(show),
      timing: { date: context.date, period: context.time?.period,
        vibe: context.time?.vibe, daypartMood: context.time?.mood,
        minutesToBoundary: phase.minutesRemaining, showPhase: phase.phase },
      atmosphere: { weather: { condition: context.weather?.condition, temp: context.weather?.temp,
        unit: context.weather?.tempUnit, daylight: context.weather?.isDay },
        festival: context.festival ? { name: context.festival.name,
          description: context.festival.description, mood: context.festival.mood } : null },
      verifiedRecent: verified.entries,
      editorialMemory: snapshot.memory,
      movement: snapshot.movement ? { movement: snapshot.movement.movement,
        destination: snapshot.movement.destination, next: snapshot.movement.next,
        energy: snapshot.movement.energy, progress: snapshot.movement.progress,
        startedAt: snapshot.movement.startedAt, expiresAt: snapshot.movement.expiresAt,
        lastDecision: snapshot.movement.lastDecision } : null,
      acoustic: acoustic ?? { status: 'unavailable', note: 'No verified acoustic observation available; never infer completion.' },
      transition: briefing,
      culturalHeadlines: culture,
    };
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), MAX_MODEL_MS);
    let result: unknown;
    try {
      result = directorV3ModelResult(await djObject({ kind: `mi.v3.${action}`, system: SYSTEM,
        prompt: `Editorial context (read-only facts): ${JSON.stringify(input)}\n\n${action === 'seed'
          ? 'Seed one viable 15–40 minute movement within remaining show airtime. If the available evidence or time makes this unwise, choose action:defer and set the nullable fields to null.'
          : 'Review actual progress and choose continue, resolve or reroute. Do not claim a destination was measured.'}`,
        schema: action === 'seed' ? directorV3SeedSchema : directorV3ReviewSchema, maxOutputTokens: 1400,
        temperature: 0.45, maxRetries: 0, signal: abort.signal }));
    } finally { clearTimeout(timeout); }
    if (action === 'seed' && (result as { action?: string })?.action === 'defer') {
      retryAfter = Date.now() + 12 * 60_000;
      logEvent('direction.v3_deferred', { showId: start.showId });
      return;
    }
    // The show, operator intent or actual latest start may have changed during
    // this separate LLM call. They override any proposal without exception.
    const latestShow = settings.resolveActiveShow();
    if ((latestShow?.id ?? null) !== start.showId
      || JSON.stringify(briefShow(latestShow)) !== captured.showSignature) return;
    let rejection: string | undefined;
    const accepted = musicDirection.commitDirectorV3({ eventId: start.eventId,
      trackId: start.trackId, showId: start.showId, at: start.at,
      expectedRevision: captured.revision, expectedMovementId: captured.movementId,
      remainingMinutes: incomingShowPhase(null).minutesRemaining,
      action, output: result }, reason => { rejection = reason; });
    logEvent('direction.v3_result', { action, accepted, showId: start.showId,
      ...(rejection ? { rejection } : {}) });
    if (accepted) retryAfter = Date.now() + 90_000;
  } catch (err) {
    retryAfter = Date.now() + 180_000;
    logEvent('direction.v3_error', { action, error: (err as Error).name ?? 'Error' });
  } finally { running = false; }
}

function briefShow(show: any) {
  if (!show) return { name: 'Default programming', topic: null,
    moods: [], genres: [], eras: [], energies: [], playlistStrict: false, filtersStrict: false };
  return {
    name: typeof show.name === 'string' ? show.name.slice(0, 100) : null,
    topic: typeof show.topic === 'string' ? show.topic.slice(0, 250) : null,
    moods: (show.moods ?? []).slice(0, 8).map((m: string) => String(m).slice(0, 50)),
    genres: (show.genres ?? []).slice(0, 8).map((g: string) => String(g).slice(0, 50)),
    eras: (show.eras ?? []).slice(0, 5),
    energies: (show.energies ?? []).slice(0, 4), vocals: show.vocals ?? null,
    playlistStrict: show.playlistStrict === true, filtersStrict: show.filtersStrict === true,
    playlistAnchors: show.playlistIds?.length ?? 0,
  };
}

// Evidence is a *bounded preview*, never a new eligibility/queue authority.
async function transitionBrief(outgoing: any, incoming: any, minutes: number | null) {
  if (minutes == null || minutes > 60) return null;
  const read = async (show: any): Promise<PlaylistPool | null> =>
    show?.playlistIds?.length ? await resolveShowPlaylistPool(show) : null;
  let current: PlaylistPool | null = null, next: PlaylistPool | null = null;
  try {
    // Playlist resolution is remote and optional. Never hold an editorial call
    // indefinitely for it; the read may finish later in the shared cache.
    [current, next] = await Promise.race([
      Promise.all([read(outgoing), read(incoming)]),
      new Promise<[null, null]>(resolve => setTimeout(() => resolve([null, null]), 3500)),
    ]);
  } catch { /* missing remote playlist evidence is unknown, not empty */ }
  const shared = current && next ? current.tracks.filter(s => next!.ids.has(s.id)) : [];
  return {
    nextShow: briefShow(incoming), minutesUntilHandoff: minutes,
    outgoingMaterial: current ? { origin: 'playlist_union', total: current.tracks.length,
      sample: getPlaylistMusicFacts(current.tracks.slice(0, 8), library.getPlaybackMeta) }
      : sampledShowMusic(outgoing, library),
    incomingMaterial: next ? { origin: 'playlist_union', total: next.tracks.length,
      sample: getPlaylistMusicFacts(next.tracks.slice(0, 8), library.getPlaybackMeta) }
      : sampledShowMusic(incoming, library),
    sharedPlaylistMembers: current && next ? { count: shared.length,
      sample: getPlaylistMusicFacts(shared.slice(0, 6), library.getPlaybackMeta),
      note: 'Overlapping playlist membership only; further hard locks, recency and timing may exclude items.' }
      : { count: null, sample: [], note: 'Playlist intersection unavailable or not applicable; do not infer zero compatibility.' },
    rule: 'Incoming show eligibility and the actual boundary remain authoritative. No song is reserved.',
  };
}
