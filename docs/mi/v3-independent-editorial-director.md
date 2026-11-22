# MI v3 — Independent Editorial Director

Base: exact v2.5.1 Git commit `8a72cb8a9fa251412f354eb3cda7d48bb3b423fd`.

## Purpose

Separate *why and where the show moves* from *which eligible song plays next*.
The Director is not a second scheduler and cannot admit, reserve, queue, skip, or override songs. Existing Agent, Pool, show locks, playlist locks, recency, listener/operator authority, and Liquidsoap decisions remain authoritative.

## Activation and rollback

Off by default. Requires all flags:

- `SUBWAVE_MUSIC_DIRECTION_V1=1`
- `SUBWAVE_MUSIC_DIRECTOR_V2=1`
- `SUBWAVE_MUSIC_TRAJECTORY_V1=1`
- `SUBWAVE_MI_DIRECTOR_V3=1`

When v3 is off, the Agent's v2.5.1 direction proposals remain enabled. When on, Agent proposals are suppressed and an independent bounded model call seeds/reviews movements. Turning off the new flag restores the legacy director behavior. Preserve the exact v2.5.1 controller/web image digests before any release; do not modify broadcast.

Optional `SUBWAVE_MI_V3_CULTURAL_FEED_URL` accepts one operator-approved HTTPS RSS/Atom feed. Empty = no cultural network request. It is not arbitrary web search or comprehensive trend research. Headlines are unverified inspiration and never change show eligibility. No listener data is sent to that feed.

## Editorial lifecycle

1. Only a **real mixer start** with an exact song ID is eligible to trigger an asynchronous Director run. Human/request starts cannot seed or review.
2. The autonomous seed requires at least 15 minutes before a known show boundary; a seed can explicitly defer. Successful seeds record movement, destination, next step, energy intention, horizon and reason.
3. Reviews occur after at least 6 elapsed minutes since the last decision and either 3 verified starts, 12 elapsed minutes, or a show boundary within 8 minutes. They choose exactly `continue`, `resolve`, or `reroute` with a bounded reason and next/alternate steps.
4. All independent model outputs must still match the most recent mixer event, exact track/show, revision, movement identity, no pending/human steering, age <=120 s, and unchanged show signature. Slow responses are discarded, not reinterpreted.
5. A single model call is in flight at a time. LLM budgets, station idle policy and failure cooldown apply. Model calls and cultural research never block the queue watcher, next song, or audio engine.
6. Existing durable state file remains version 1 with optional v3 movement/decision fields. No schema or database migration. A new small best-effort `mi-v3-trajectory.json` sidecar stores only the last acoustic display observation.

## Grounding and feasibility

Director context is bounded to actual verified airplay (12), existing editorial memory, current show brief, minutes to boundary, atmospheric/daypart/weather/festival context, available measured acoustic evidence, and sampled eligible-looking catalogue facts. A coming show within 60 minutes can add both playlist-union samples and their intersection. **Samples are not exhaustive and overlapping playlists are not proof of meeting all filters.** The existing picker continues to enforce final constraints. No song plan or future queue reservation is stored.

## Dashboard

`/dj/steer` stays read-only for status and retains its existing authentication and write contract. With v3 on, it additionally reports `directorV3:true` and `acousticObservation` (not measured / insufficient / unavailable / stale / measured). The movement card renders a wall-clock progress bar **only for elapsed time**, energy intention, last committed editorial decision/reason and latest resolved decision. No claims of percentage-to-semantic-destination.

The 45-second private picker acoustic cache is preserved. Dashboard acoustic evidence is a separate latest verified-start observation that survives pick-cache expiry and restarts when its best-effort sidecar can be written.

## Practical qualification

Run `npm run typecheck` and the focused tests in `controller`; verify v3 off versus the exact v2.5.1 source at representative candidate/prompt/queue boundaries, and verify v3 on in an isolated controller fixture with a fabricated mixer start. Run `web` typecheck. Review authenticated admin GET and that requests do not trigger extra model calls. Preserve a one-command controller/web rollback to v2.5.1 and do not rebuild the personalized public web image from an unrelated branch. No need to rerun unrelated known baseline-failing suites without evidence of a new regression.
