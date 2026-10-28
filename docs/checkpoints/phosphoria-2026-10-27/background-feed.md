# Background metadata and controller reliability

## Web correction

Visible feed cadence remains 5s. Hidden audio playback now refreshes only
`now-playing` + `state` every 15s; paused hidden players make no feed requests.
Foreground visibility/focus/pageshow/resume revalidates immediately, coalescing
duplicate return events. Browsers may freeze background timers, so foreground
revalidation remains mandatory. No unchanged audio element is reconnected,
seeked or replaced.

Requests retain latest-wins sequence/abort ownership. Held audible-boundary
promotions belong to the last accepted coherent snapshot and are cancelled by
foreground supersession or a newer accepted snapshot. A hidden update or a fresh
foreground reconciliation gets a new one-shot reconciliation event; a witnessed
future audible boundary still gets its normal choreography. Song transition
effects, durations, layout, native lyrics and clocks are unchanged.

An on-air station's transient null metadata marker retains the last accepted
track. Explicit offline/idle clears it. A cold client with no accepted metadata
now says `Waiting for track details` rather than `Somewhere on the dial`.

Changed implementation: `lib/stationPolling.ts`, `lib/stationFeedMetadata.ts`,
`hooks/useStationFeed.ts`, audio-activity ref wiring in `PlayerCore.tsx`, one
optional state field in `lib/types.ts`, and fallback copy in `SxntaxSkin.tsx`.
The skin's choreography itself is not edited.

Typecheck, targeted lint, whitespace checks and 17 focused nonvisual scheduler,
metadata-retention, foreground-gate and clock/stall tests passed before build.
The scheduler tests use Node EventTarget and fake time only, not a browser or
synthetic rendered presentation. No visual automation was used.

## Controller evidence, not a browser-caused outage

The unified-log digest covers 2026-10-28 08:13:24Z–14:14:55Z:

- 4,579 Navidrome calls; 15 errors. `getRandomSongs` failed 14/53 times;
  maximum duration 94,765ms. `getSimilarSongs2` failed once.
- Auto-playlist trace durations included 282,509ms and 238,727ms. Missed cron
  minutes occur around scheduled auto-playlist rebuilds, alongside request
  timeouts and the Navidrome circuit opening.
- The running client retries a Subsonic call three times with a 30s per-attempt
  timeout. That accounts for the approximately 95s failed calls; an asynchronous
  wait alone does not prove which synchronous work delayed the cron loop.
- Readiness is uncached: each `/ready` performs `ping` then a size-1 album list.
  The digest has 2,076 pings and 2,075 identical size-1 album-list calls, consistent
  with the 10s health-probe path. Thus dependency checks are a major existing
  upstream-call source and keep running while slow work/retries are pending.
- Controller targets internal `http://navidrome:4533`, not a Cloudflare origin.
- 13/14 agent pick decisions succeeded; 16 aired tracks had 16 distinct artists
  and no artist repeated within three plays. Pick p95/max was 74,618ms. Musical
  variety is not the reliability failure in this window.

The existing frontend had NO hidden polling, so the requested background-refresh
feature cannot have caused those historical controller stalls. Live probes at
inspection were healthy (~0.25s health/now-playing, ~0.3% controller CPU).
The controller's exact long event-loop blocker is not isolated by these logs;
slow upstream calls/retry accumulation, heavy auto-playlist rebuilds and uncached
readiness load are established findings. A controller-side follow-up should
bound/cache/coalesce dependency probes and instrument synchronous work during a
rebuild rather than guess at a model change or restart repeatedly. No controller
code/configuration, playlist behavior or broadcast service is changed here.

## Deployment drift

Inspection found production had again been rebuilt from the older
`SUBWAVE_P21_4_POLISH/deploy.yml` entrypoint rather than the accepted checkpoint's
follow-up release. The operator overlay is aligned to this web build to avoid
silently restoring older polling/reconciliation behavior on the next stack
update. The checkpoint tag and its exact image archive remain unchanged.

Web image for this release: `subwave-web:background-station-feed-fix`.
Build from this checkout with its existing `web/Dockerfile`. Promote web only
with `web.background-feed.yml` as the final image override and
`up -d --no-deps --no-build --pull never web`.
