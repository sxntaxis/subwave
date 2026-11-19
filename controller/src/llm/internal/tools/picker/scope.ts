// The picker's per-pick scope + the context every discovery tool runs against.
//
// Scope is ONE value on purpose: every constraint a pick runs under travels from
// pickViaAgent (broadcast/dj-agent.ts) to the tools as a single `PickerScope`
// that is never destructured into per-field lists along the way. A lock named in
// one list and forgotten in another is neither a type error nor a crash — it
// falls through to a null default and stops being enforced on the agent path
// while the pool picker still honours it (#1300 FR 13, vocalLock). Adding a lock
// means adding a field here; do not reintroduce a per-field hand-off.

import * as library from '../../../../music/library.js';
import * as embeddings from '../../../../music/embeddings.js';
import { artistKey, filterPickerCandidates } from '../../../../music/recency.js';
import { applyStrictLocks, type VocalMode } from '../../../../music/show-filter.js';
import { applyTrackFloor } from '../../../../music/track-floor.js';
import { freshnessBiasedOrder } from '../../../../music/airing.js';
import { SEED_NOT_A_PICK_CLAUSE } from '../../../../util/pick-seed.js';
import { slim } from './slim.js';
import { createSelectionAttempt } from './selection-attempt.js';
import { getSharedAcousticIndex, type IndexedAcousticRow } from '../../../../music/library-db/acoustic-index.js';
import { parseKeyRanges, parsePaceSpans } from '../../../../music/library-db/rows.js';
import { endingKeyFrom, openingKeyFrom } from '../../../../music/mix.js';
import { scoreSelection, type AcousticEvidence } from '../../../../music/selection-score.js';
import { composeSelection } from '../../../../music/selection-compose.js';
import type { PickerSelectionObservation } from '../../../../observability/picker-audit.js';
import { AsyncLocalStorage } from 'node:async_hooks';

type SeedFixture = { lookup: (id: string, kind: 'audio' | 'text') => any[]; audio: boolean; text: boolean };
const seedFixtureScope = new AsyncLocalStorage<SeedFixture>();
const acousticReaderFixture = new AsyncLocalStorage<
  (ids: readonly string[], timeoutMs: number) => Promise<IndexedAcousticRow[] | null>
>();
export function withPickerSeedFixtureForTest<T>(fixture: SeedFixture, fn: () => T): T {
  return seedFixtureScope.run(fixture, fn);
}
export function withPickerAcousticReaderForTest<T>(
  reader: (ids: readonly string[], timeoutMs: number) => Promise<IndexedAcousticRow[] | null>,
  fn: () => T,
): T {
  return acousticReaderFixture.run(reader, fn);
}

export interface PickerScope {
  // Set exclusively by the autonomous picker after validating its predecessor.
  selection?: { predecessorId: string; recentAiredIds: string[] };
  // Private opt-in audit observer; receives bounded counters only.
  selectionAudit?: (observation: PickerSelectionObservation) => void;
  // Optional attempt-local accumulator. The track picker supplies this so it
  // can snapshot the same IDs exposed through PickerExtras even if the agent
  // rejects/throws before returning extras. Not prompt/tool data.
  seen?: Map<string, any>;
  recentIds: Set<string>;
  // lowercased "title|artist" — backfilled entries lack ids
  recentKeys: Set<string>;
  // Count-based HARD no-repeat set (last N distinct plays), non-relaxable: a
  // track here survives the starvation cascade, so the agent cannot re-pick a
  // just-played song. From queue.recentlyPlayedByCount(N); empty on the request
  // path (requests exempt).
  hardRecentIds: Set<string>;
  // lowercased "title|artist" — blocks id-less backfilled plays
  hardRecentKeys: Set<string>;
  // The five show locks below apply only for a strict show (one filtersStrict
  // toggle governs all of them), are any-of lists, and are HARD in collect() —
  // no per-tool never-starve. null/empty = no lock. None is set on the request
  // path: an explicit listener ask wins.
  genreLock: string[] | null;
  // Unknown-year tracks drop (#929).
  eraLock: { fromYear?: number | null; toYear?: number | null }[] | null;
  moodLock: string[] | null;
  // Analysed bands; unknowns drop.
  energyLock: string[] | null;
  vocalLock: VocalMode | null;
  // Minimum track length in seconds (#1573), show floor else station default,
  // resolved by settings.effectiveMinTrackSec. NOT gated on filtersStrict — it
  // is the twin of the max-track-length cap, which no show opts into either.
  // HARD here; the pool picker never-starves on the same floor behind it.
  // null = no floor, and not set on the request path.
  minTrackSec: number | null;
  // Union of a strict playlist-anchored show's pinned Navidrome playlists; every
  // tool's candidates are intersected with it, HARD with no never-starve to
  // off-playlist, because a playlist is an exact set and showPlaylistTracks is
  // the guaranteed in-set source. null = no lock; not set on the request path.
  playlistLock: Set<string> | null;
  // The show's playlist union tracks; registers the showPlaylistTracks tool. Set
  // in BOTH strict (with playlistLock) and soft (prompt preference only) modes.
  playlistTracks: any[] | null;
  // Ids from the show's excluded playlists, dropped from every tool's results so
  // the agent never sees a blocklisted track. null = no exclusions.
  excludedIds: Set<string> | null;
  // The active sonic journey's waypoint vector. When present the
  // tracksTowardJourney tool is registered closing over it, so the agent sees
  // only the tracks near it.
  audioWaypoint: number[] | null;
  // Request path only: registers identifyRequestedTrack. No-op unless a
  // web-search provider is ready. Never set on the per-track picker.
  resolveReferences: boolean;
}

// Every field defaults to "no constraint". Spread over a partial so there is
// exactly one place a new field's default lives.
const NO_SCOPE: PickerScope = {
  recentIds: new Set(),
  recentKeys: new Set(),
  hardRecentIds: new Set(),
  hardRecentKeys: new Set(),
  genreLock: null,
  eraLock: null,
  moodLock: null,
  energyLock: null,
  vocalLock: null,
  minTrackSec: null,
  playlistLock: null,
  playlistTracks: null,
  excludedIds: null,
  audioWaypoint: null,
  resolveReferences: false,
};

export function pickerScope(partial: Partial<PickerScope> = {}): PickerScope {
  return { ...NO_SCOPE, ...partial };
}

// What each tool module is handed: the scope plus the shared machinery — the
// `seen` accumulator, the filter/slim/record pipeline, the empty-result note
// builder, and the index-coverage flags the conditional tools gate on.
export interface PickerContext {
  scope: PickerScope;
  // id → slim song across all tool calls; the picker resolves the agent's final
  // id choice against this.
  seen: Map<string, any>;
  collect(list: any, cap?: number, opts?: { maxPerArtist?: number }): any[];
  collectAsync(list: any, cap?: number, opts?: { maxPerArtist?: number }): Promise<any[]>;
  emptyResult(matched: number, hint: string): { tracks: any[]; note: string; rule: string };
  seedSimilarity(songId: string, primary: 'audio' | 'text'): { tracks: any[]; matched: number; fellBack: boolean };
  seedSimilarityAsync(songId: string, primary: 'audio' | 'text'): Promise<{ tracks: any[]; matched: number; fellBack: boolean }>;
  // Id-level union of the recency sets, pushed INTO KNN queries. The key-based
  // sets can't ride along (vec0 rows carry only ids); collect() catches those
  // post-hoc.
  knnExclude: Set<string>;
  stats: { total?: number; withEmbedding?: number; withAudioEmbedding?: number; [k: string]: any };
  hasTextEmbeddings: boolean;
  hasAudioEmbeddings: boolean;
  hasEmbeddingProvider: boolean;
  // True when most of the text index is label-only vectors, i.e. "semantic
  // similarity" is really artist-string proximity. The text-similarity tools
  // adjust their descriptions accordingly.
  textIndexDegraded: boolean;
}

export function buildPickerContext(
  scope: PickerScope,
  readAcoustics = acousticReaderFixture.getStore(),
  seedFixture: SeedFixture | undefined = seedFixtureScope.getStore(),
): PickerContext {
  const {
    recentIds, recentKeys, hardRecentIds, hardRecentKeys,
    genreLock, eraLock, moodLock, energyLock, vocalLock,
    minTrackSec, playlistLock, excludedIds,
  } = scope;

  const seen = scope.seen ?? new Map<string, any>();

  // Pushed into every KNN query so a heavily-aired cluster answers with its next
  // neighbours out instead of thinning toward empty.
  const knnExclude: Set<string> = new Set([...recentIds, ...hardRecentIds]);

  // Filter recents, slim, and record into `seen` so the picker can resolve the
  // agent's final id choice to a full track. Drops recently-played tracks (by
  // id/key) and tracks already surfaced this pick; artists are NOT filtered (see
  // the buildPickerTools note in index.ts). cap=8 keeps per-tool input tokens
  // down; `seen` still accumulates across the whole loop.
  //
  // `maxPerArtist` (default 3) is a CAP, deliberately not an artist-recency strip
  // (#618 — a strip gutted the similarity tools to ~1 survivor on niche
  // catalogues): one artist just can't fill all 8 slots, which is what a
  // label-only embedding index does on a keyless install. The two single-artist
  // tools (topSongsByArtist, recentByArtist) opt out. A strict PLAYLIST show opts
  // out wholesale — playlistLock has already intersected the pool with the
  // operator's pinned set, and a single-artist playlist is the point of pinning.
  const collect = (list: any, cap = 8, opts: { maxPerArtist?: number } = {}) => {
    // Strict show: filter BEFORE recency + cap, so the 8 the agent sees are
    // genre-/era-/mood-/energy-pure. Each lock is HARD (starve:true) — a tool
    // with no match contributes nothing and emptyResult steers the model
    // elsewhere. Dead-air is guarded at wider scopes: a run with zero candidates
    // falls to the pool picker, and behind that the auto.m3u coast. The locks are
    // pre-resolved and coverage-gated in pickViaAgent, so an un-analysed library
    // can't starve every tool for the whole show.
    //
    // Ordering is a freshness-biased shuffle (music/airing.ts): a KNN tool's
    // top-60 must not reach the model in similarity order, or the cap of 8 pins
    // the same neighbours every pick. Randomness stays dominant; with no play
    // history this is a plain shuffle.
    let pool = applyStrictLocks(freshnessBiasedOrder((list || []) as any[], library.lastAiredInfo(), Date.now()), {
      genres: genreLock, eras: eraLock, moods: moodLock, energies: energyLock, vocals: vocalLock,
    }, { starve: true });
    // Minimum track length (#1573): hard, and BEFORE the playlist lock, so a
    // pinned playlist's own 40-second interlude drops too — the floor is about
    // what the station will AIR, not which source a track came from.
    pool = applyTrackFloor(pool, minTrackSec, { starve: true });
    if (playlistLock) pool = pool.filter((s: any) => s?.id && playlistLock.has(s.id));
    // Blocklisted playlists drop AFTER the playlist lock, so exclusion overrides
    // the anchor. No never-starve: a show that excludes its whole pool leaves
    // `seen` empty and the LLM pick is skipped, with the auto.m3u coast behind it.
    if (excludedIds) pool = pool.filter((s: any) => s?.id && !excludedIds.has(s.id));
    const accepted = filterPickerCandidates(pool, {
      recentIds,
      recentKeys,
      hardRecentIds,
      hardRecentKeys,
      seenIds: new Set(seen.keys()),
      maxPerArtist: opts.maxPerArtist ?? (playlistLock ? Infinity : 3),
      cap,
    });
    const out: any[] = [];
    for (const s of accepted) {
      const slimmed = slim(s);
      seen.set(s.id, slimmed);
      out.push(slimmed);
    }
    return out;
  };

  const attempt = scope.selection ? createSelectionAttempt() : null;
  const collectAsync: PickerContext['collectAsync'] = (list, cap = 8, opts = {}) => {
    if (!attempt || !scope.selection) {
      const accepted = collect(list, cap, opts);
      scope.selectionAudit?.({
        reason: 'no_eligible_context', eligibleCandidates: Array.isArray(list) ? list.length : 0,
        offeredCandidates: accepted.length,
      });
      return Promise.resolve(accepted);
    }
    const selection = scope.selection;
    return attempt.transaction(async () => {
      // Exactly one shuffle: the very same pool supplies both ranked and
      // fail-open results. Restrictions precede scoring and caps.
      let pool = applyStrictLocks(freshnessBiasedOrder((list || []) as any[], library.cachedLastAiredInfo(), Date.now()), {
        genres: genreLock, eras: eraLock, moods: moodLock, energies: energyLock, vocals: vocalLock,
      }, { starve: true });
      pool = applyTrackFloor(pool, minTrackSec, { starve: true });
      if (playlistLock) pool = pool.filter((s: any) => s?.id && playlistLock.has(s.id));
      if (excludedIds) pool = pool.filter((s: any) => s?.id && !excludedIds.has(s.id));
      const maxPerArtist = opts.maxPerArtist ?? (playlistLock ? Infinity : 3);
      const eligible = filterPickerCandidates(pool, {
        recentIds, recentKeys, hardRecentIds, hardRecentKeys,
        seenIds: new Set(seen.keys()), maxPerArtist: Infinity, cap: Infinity,
      });
      const baseline = () => filterPickerCandidates(eligible, { maxPerArtist, cap });
      let accepted = baseline();
      let reason: PickerSelectionObservation['reason'] = 'no_eligible_context';
      let lookupMs: number | undefined;
      if (eligible.length > 256) {
        reason = 'candidate_ceiling';
      } else if (eligible.length) {
        let acousticIndex: ReturnType<typeof getSharedAcousticIndex> = null;
        try { if (!readAcoustics) acousticIndex = getSharedAcousticIndex(); } catch {}
        if (!readAcoustics && !acousticIndex) {
          reason = 'index_unavailable';
        } else {
          const lookup = await attempt.lookupObserved(
          eligible.map(s => s.id), [selection.predecessorId, ...selection.recentAiredIds],
          async (ids, timeout) => {
            if (readAcoustics) return readAcoustics(ids, timeout);
            return acousticIndex ? acousticIndex.lookup(ids, timeout) : null;
          },
        );
          lookupMs = lookup.elapsedMs;
          reason = lookup.reason === 'candidate_ceiling' ? 'candidate_ceiling'
            : lookup.reason === 'deadline_or_budget' ? 'deadline_or_budget'
              : lookup.reason === 'no_eligible_context' ? 'no_eligible_context'
                : lookup.reason === 'index_unavailable' ? 'index_unavailable'
                  : 'missing_predecessor_evidence';
          try { if (lookup.rows) {
          const rows = lookup.rows;
          const byId = new Map(rows.map(row => [row.id, row]));
          const evidence = (row: IndexedAcousticRow | undefined): AcousticEvidence | null => {
            if (!row?.track) return null;
            const track = row.track;
            const ranges = track.key_ranges_json ? parseKeyRanges(track.key_ranges_json) : null;
            return { bpm: track.bpm, key: track.musical_key,
              keyStart: openingKeyFrom(ranges, track.musical_key),
              keyEnd: endingKeyFrom(ranges, track.duration_sec == null ? null : track.duration_sec * 1000, track.musical_key),
              pace: track.pace_json ? parsePaceSpans(track.pace_json) : null, vector: row.vector };
          };
          const predecessor = evidence(byId.get(selection.predecessorId));
          if (predecessor) {
            const aired = selection.recentAiredIds.map(id => evidence(byId.get(id))).filter((x): x is AcousticEvidence => x !== null);
            const playlistIds = new Set((scope.playlistTracks ?? []).map(s => s.id));
            const ranked = eligible.map((s, i) => {
              const acoustic = evidence(byId.get(s.id));
              const score = scoreSelection({ enabled: true, sameShow: true, anchorReliable: true, predecessor,
                recentAired: aired, candidate: acoustic ?? {}, baselineRank: i, candidateCount: eligible.length,
                softBoundPlaylistMember: !playlistLock && playlistIds.has(s.id) });
              return { value: s, id: s.id, artistKey: artistKey(s), baselineIndex: i, utility: score.utility, acoustic, flow: score.flow };
            });
            // Missing evidence must not turn MMR into a different baseline.
            if (ranked.some(item => item.flow !== null)) {
              accepted = composeSelection(ranked, cap, maxPerArtist);
              const baselineIds = baseline().map(s => s.id);
              const acceptedIds = accepted.map(s => s.id);
              const baselineSet = new Set(baselineIds);
              const membershipChanged = baselineSet.size !== new Set(acceptedIds).size
                || acceptedIds.some(id => !baselineSet.has(id));
              reason = membershipChanged ? 'scored_membership_change' : 'scored_no_membership_change';
              scope.selectionAudit?.({
                reason, eligibleCandidates: eligible.length, offeredCandidates: accepted.length,
                lookupMs, orderedShortlistChanged: baselineIds.length !== acceptedIds.length
                  || baselineIds.some((id, i) => acceptedIds[i] !== id),
              });
              return accepted.map(s => {
                const value = slim(s);
                seen.set(s.id, value);
                return value;
              });
            }
            reason = 'missing_flow';
          }
          }
          } catch {
          // Malformed optional evidence must not lose an otherwise valid tool.
            reason = 'scorer_exception';
          }
        }
      }
      scope.selectionAudit?.({
        reason, eligibleCandidates: eligible.length, offeredCandidates: accepted.length, lookupMs,
      });
      return accepted.map(s => {
        const value = slim(s);
        seen.set(s.id, value);
        return value;
      });
    });
  };

  // On an empty tool result, say WHY and what to try next: a bare [] draws a
  // fabricated id. `matched` is the pre-recency-filter count, so the note can
  // distinguish "nothing matches" from "matches exist but were all filtered" —
  // opposite next moves. A strict lock is anything that can drop a candidate the
  // source DID return, so all of them count here, not just recency.
  const hasStrictLock = !!(genreLock?.length || eraLock?.length || moodLock?.length || energyLock?.length || vocalLock || playlistLock || excludedIds || minTrackSec);
  // The seed clause rides here as well as on the schema field (#1247): this is
  // the message in context at the moment the model fails, and "never invent a
  // song id" is satisfied by echoing the on-air seed. Wording from
  // util/pick-seed.ts.
  const emptyResult = (matched: number, hint: string) => ({
    tracks: [] as any[],
    note: matched > 0
      ? `${matched} matching track(s) exist but were all played recently, already shown this pick${hasStrictLock ? ', or outside this show\'s strict filters' : ''} — ${hint}`
      : hint,
    rule: `Never invent a song id — only ids returned by a tool are valid picks. ${SEED_NOT_A_PICK_CLAUSE}`,
  });

  // Index counts snapshotted once at tool-build time; pickViaAgent awaits
  // library.load() first, so stats() never returns its empty-sentinel zeros
  // here. Tools whose backing index is empty are conditionally registered —
  // offering a dead tool spends the discovery call on a guaranteed-empty result.
  const stats = library.stats();
  const hasTextEmbeddings = seedFixture?.text ?? (stats.withEmbedding ?? 0) > 0;
  const hasAudioEmbeddings = seedFixture?.audio ?? (stats.withAudioEmbedding ?? 0) > 0;
  const hasEmbeddingProvider = embeddings.isAvailable();
  // Same 50% threshold the coverage UI calls similarityThin.
  const labelShare = library.labelOnlyShare();
  const textIndexDegraded = labelShare != null && labelShare > 0.5;

  // Seed-similarity with a cross-index rescue (#1247). An empty seed tool corners
  // a forced-tool provider — it gets one discovery call, and the only well-formed
  // id left in context is the on-air seed. Index registration keys on whether an
  // index holds ANY vectors, never on whether it covers THIS seed, and coverage
  // is routinely partial, so answer from the other index and say so.
  //
  // Gated on the primary returning NOTHING AT ALL (no vector for the seed). A
  // primary that matched but was filtered by recency keeps emptyResult, whose
  // note steers correctly and describes a different situation.
  const seedSimilarity = (songId: string, primary: 'audio' | 'text') => {
    const K = 60;
    const audioFirst = primary === 'audio';
    const lookup = (which: 'audio' | 'text') =>
      seedFixture ? seedFixture.lookup(songId, which) : which === 'audio'
        ? library.tracksLikeThisAudio(songId, K, { excludeIds: knnExclude })
        : library.tracksLikeThis(songId, K, { excludeIds: knnExclude });
    const list = lookup(primary);
    if (list.length) return { tracks: collect(list), matched: list.length, fellBack: false };
    const other = audioFirst ? 'text' : 'audio';
    const otherIndexed = audioFirst ? hasTextEmbeddings : hasAudioEmbeddings;
    if (otherIndexed) {
      const alt = lookup(other);
      if (alt.length) {
        const rescued = collect(alt);
        // Only report the rescue if something SURVIVED the recency/lock filters.
        // A raw alt count with empty tracks would render emptyResult's matched>0
        // note about an index the model never asked, glued to a "no embedding
        // yet" hint about the one it did. Falling through to 0 keeps it coherent.
        if (rescued.length) return { tracks: rescued, matched: alt.length, fellBack: true };
      }
    }
    return { tracks: [] as any[], matched: 0, fellBack: false };
  };

  const seedSimilarityAsync: PickerContext['seedSimilarityAsync'] = async (songId, primary) => {
    if (!attempt) return seedSimilarity(songId, primary);
    const lookup = (which: 'audio' | 'text') => seedFixture ? seedFixture.lookup(songId, which) : which === 'audio'
      ? library.tracksLikeThisAudio(songId, 60, { excludeIds: knnExclude })
      : library.tracksLikeThis(songId, 60, { excludeIds: knnExclude });
    const list = lookup(primary);
    if (list.length) return { tracks: await collectAsync(list), matched: list.length, fellBack: false };
    const other = primary === 'audio' ? 'text' : 'audio';
    if (primary === 'audio' ? hasTextEmbeddings : hasAudioEmbeddings) {
      const alt = lookup(other);
      if (alt.length) {
        const tracks = await collectAsync(alt);
        if (tracks.length) return { tracks, matched: alt.length, fellBack: true };
      }
    }
    return { tracks: [], matched: 0, fellBack: false };
  };

  return { scope, seen, collect, collectAsync, emptyResult, seedSimilarity, seedSimilarityAsync, knnExclude, stats, hasTextEmbeddings, hasAudioEmbeddings, hasEmbeddingProvider, textIndexDegraded };
}
