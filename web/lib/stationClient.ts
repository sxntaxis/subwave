'use client';

// The one place player code talks to a controller. Every fetch and every
// controller-relative URL (covers, persona avatars) is built here from a
// StationOrigin, so pointing the player at another station means swapping the
// origin (stationOrigin.ts) — no call site hardcodes a path.
//
// Response handling is deliberately per-endpoint: feed endpoints require fresh,
// successful, correctly shaped JSON; /schedule and /themes throw on non-OK; /request/:id maps
// 404 to status 'unknown', the beacon is fire-and-forget. Keep it that way;
// this module is plumbing, not policy.

import type { LyricDocument } from '@/components/skins/sxntax/lyrics/lyricsModel';
import { getStationAuthToken } from '@/lib/stationAuth';
import { useMemo } from 'react';
import {
  DEFAULT_STATION_ORIGIN,
  useStationOrigin,
  type StationOrigin,
} from '@/lib/stationOrigin';
import type { Theme } from '@/lib/theme';
import type {
  NowPlayingResponse,
  RequestResult,
  SchedulePayload,
  SessionPayload,
  StationState,
} from '@/lib/types';

export interface ThemesPayload {
  /** The effective theme — what a client should actually paint. */
  active: string;
  /** Which level decided `active`. Absent on an older controller. */
  activeSource?: 'show' | 'station';
  /** settings.theme.active, i.e. what admin's station picker sets. */
  stationDefault?: string;
  /** Set only when an on-air show's themeId outranked the station default. */
  activeShow?: { id: string; name: string; themeId: string } | null;
  themes: Theme[];
}

export interface BeaconPayload {
  referrer: string;
  path: string;
  utmSource?: string;
}

/** Error statuses (403 disabled, 409 stale/no track, 429 throttled) still
 *  carry a JSON body with `error`. */
export interface LikeResult {
  ok?: boolean;
  songId?: string | null;
  liked?: boolean;
  alreadyLiked?: boolean;
  count?: number;
  error?: string;
}

/** Liked-state for the current airing, per listener via a server-side dedup
 *  key — no account needed. */
export interface LikeStatus {
  enabled: boolean;
  songId?: string | null;
  liked?: boolean;
  count?: number;
}

export interface StationClient {
  origin: StationOrigin;
  /** Prefix a controller-relative path with the station's API base.
   *  Empty/nullish input stays '' so `<img>` fallbacks keep working. */
  resolve(path: string | null | undefined): string;
  coverUrl(subsonicId: string): string;
  nowPlaying(signal?: AbortSignal): Promise<NowPlayingResponse>;
  /** Only the current aired Subsonic ID can be queried; 409 means stale. */
  currentLyrics(songId: string, signal?: AbortSignal): Promise<{ songId: string; document: LyricDocument | null }>;
  state(signal?: AbortSignal): Promise<StationState>;
  session(): Promise<SessionPayload>;
  /** The caller owns timeout/abort. */
  health(init?: { signal?: AbortSignal }): Promise<Response>;
  schedule(init?: { signal?: AbortSignal }): Promise<SchedulePayload>;
  themes(): Promise<ThemesPayload>;
  submitRequest(text: string, name: string): Promise<RequestResult>;
  /** 404 → status 'unknown'; network error → null so drawers keep polling. */
  requestStatus(requestId: string): Promise<RequestResult | null>;
  /** `songId` is what the client believes is on air; the controller rejects a
   *  stale tap. null on network error. */
  likeCurrent(songId: string, liked?: boolean): Promise<LikeResult | null>;
  /** null on network error. */
  likeStatus(): Promise<LikeStatus | null>;
  /** Best-effort: never throws, never blocks. */
  beacon(payload: BeaconPayload): void;
  /** null on any failure; callers treat that as "configured" and stay put. */
  onboardingStatus(): Promise<{ needsSetup?: boolean } | null>;
}

export function createStationClient(origin: StationOrigin): StationClient {
  const api = origin.apiUrl;
  const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
  const feedJson = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetch(`${api}${path}`, {
      cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`${path} fetch ${response.status}`);
    return json<T>(response);
  };
  return {
    origin,
    resolve: path => (path ? `${api}${path}` : ''),
    coverUrl: subsonicId => `${api}/cover/${encodeURIComponent(subsonicId)}`,
    nowPlaying: async signal => {
      const result = await feedJson<NowPlayingResponse>('/now-playing', signal);
      if (!result || !Object.hasOwn(result, 'nowPlaying') || (result.nowPlaying != null && typeof result.nowPlaying.title !== 'string')) {
        throw new Error('Invalid now-playing response');
      }
      return result;
    },
    currentLyrics: async (songId, signal) => {
      const token = getStationAuthToken();
      const response = await fetch(`${api}/lyrics/current?songId=${encodeURIComponent(songId)}`, {
        cache: 'no-store', signal,
        ...(token ? { headers: { 'x-station-auth': token } } : {}),
      });
      if (!response.ok) throw new Error(`lyrics fetch ${response.status}`);
      const result = await json<{ songId: string; document: LyricDocument | null }>(response);
      if (result?.songId !== songId || !Object.hasOwn(result, 'document')) {
        throw new Error('Invalid lyrics response');
      }
      return result;
    },
    state: async signal => {
      const result = await feedJson<StationState>('/state', signal);
      if (!result || !Array.isArray(result.history) || !Array.isArray(result.upcoming)) throw new Error('Invalid state response');
      return result;
    },
    session: () => fetch(`${api}/session`).then(r => json<SessionPayload>(r)),
    health: init => fetch(`${api}/health`, { cache: 'no-store', signal: init?.signal }),
    schedule: async init => {
      const r = await fetch(`${api}/schedule`, { cache: 'no-store', signal: init?.signal });
      if (!r.ok) throw new Error(`schedule fetch ${r.status}`);
      return json<SchedulePayload>(r);
    },
    themes: async () => {
      const r = await fetch(`${api}/themes`);
      if (!r.ok) throw new Error(`themes fetch ${r.status}`);
      return json<ThemesPayload>(r);
    },
    submitRequest: async (text, name) => {
      const r = await fetch(`${api}/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, name }),
      });
      return json<RequestResult>(r);
    },
    requestStatus: async requestId => {
      try {
        const r = await fetch(`${api}/request/${requestId}`);
        if (r.status === 404) return { success: false, status: 'unknown' };
        return await json<RequestResult>(r);
      } catch {
        return null;
      }
    },
    likeCurrent: async (songId, liked = true) => {
      try {
        const r = await fetch(`${api}/like`, {
          method: liked ? 'POST' : 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ songId }),
        });
        // Error statuses carry a JSON body too. Surface it, don't throw.
        return await json<LikeResult>(r);
      } catch {
        return null;
      }
    },
    likeStatus: async () => {
      try {
        const r = await fetch(`${api}/like`);
        return await json<LikeStatus>(r);
      } catch {
        return null;
      }
    },
    beacon: payload => {
      fetch(`${api}/beacon`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    },
    onboardingStatus: async () => {
      try {
        const r = await fetch(`${api}/onboarding/status`);
        return r.ok ? ((await r.json()) as { needsSetup?: boolean }) : null;
      } catch {
        return null;
      }
    },
  };
}

/** The install this page is served from: same-origin `/api`, or the
 *  NEXT_PUBLIC_* dev overrides. Install-level concerns (theme registry,
 *  onboarding status) go through this even inside a showcase pointed at a
 *  remote station — they're about *this* deployment, not the tuned one. */
export const defaultStationClient: StationClient =
  createStationClient(DEFAULT_STATION_ORIGIN);

/** Whatever station the surrounding StationOriginProvider points at, or the
 *  default origin when there's no provider. Memoized on the origin's URL
 *  strings, which stay stable even when the origin object identity doesn't. */
export function useStationClient(): StationClient {
  const {
    apiUrl,
    streams: { mp3, opus },
  } = useStationOrigin();
  return useMemo(
    () => createStationClient({ apiUrl, streams: { mp3, opus } }),
    [apiUrl, mp3, opus],
  );
}
