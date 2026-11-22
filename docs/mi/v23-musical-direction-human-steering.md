# SUB/WAVE MI v2.3 — Musical Direction + Authoritative Human Steering

**Status:** source implementation / **NOT production-qualified or deployed**.
**Source base:** production evidence bundle `subwave-prod-mi-v22-1d9fb7bc.bundle`, base Git commit `1d9fb7bc47131e7e682b14184f2646d431b2cc7d`.

This source change has two independently significant runtime portions: the **controller** and the **Liquidsoap broadcast** script. The owner approved both architecture and implementation. Approval is **not** evidence of runtime compatibility; qualify the physical queue/mixer contract before enabling the new feature. Use one local agent/thread sequentially. Do not mutate the original dirty checkout while reconciling.

## Delivered behavior and authority

- Opt-in flag **`SUBWAVE_MUSIC_DIRECTION_V1=1`** on controller. Unset/other values preserve the controller's legacy queue/selection semantics; the broadcast script adds empty priority sources even when the flag is off, so verify parity before the controller feature is enabled.
- Authenticated operator `POST /dj/queue-track` accepts `placement: "next"` (highest priority for the next *feasible* music boundary) or the existing default `"append"`. Existing album/artist block queueing creates a `locked` block while enabled. Never-play rules remain absolute even for operators.
- Accepted listener requests reserve an arrival-ordered slot **before** their asynchronous song resolution. When a song is successfully queued, listener-priority dispatch outranks prior speculative AI, but stays behind operator `play next` and active explicit locked blocks. Failed/duplicate/chat-only requests release their reservation. The controller fences in-flight autonomous picks with an authority epoch, best-effort retracts pending AI successors by mixer RID, and never assumes that a fetched/prefetched/latched track can be cancelled.
- The broadcast has separate `operator_priority_queue` and `listener_priority_queue`, version probe `music_priority_version` returning `1`, dedicated handoff files and lane-specific pending-request removal. All music sources run through the existing crossfade/cue/codec chain. No currently playing song is force-cut by a request. **A latched next track is a physical exception**: report `next feasible`, never guarantee immediate succession against actual prefetch.
- `music-direction-v1.json` in the active station's private state directory holds bounded, show-aware human steering and current soft movement with atomic file replacement (mode 0600). Listener/owner song anchors begin **only** on an exact mixer playback token; no admission, model proposal, queue append, duplicate ID, or recovered unverified event can invent an audible human request. Listener anchors last up to four subsequent true starts/20 min; manual owner song anchors up to six/45 min. Explicit admin directives take priority, with specified scope/duration/track count.
- The existing Agent can propose a **15–40 minute soft movement** alongside the single-song pick. The proposal is speculative until that exact selected song really begins, subject to the unchanged show/authority revision. No extra planner LLM call per song. The actual on-air history (up to 12 recent tracks) remains in context; probabilistic 2–3-song mini-runs do not compete when the feature is enabled. Normal per-song eligibility, provenance, show locks and pool fallback remain authoritative.
- Discovery tools retain existing candidate/cohort eligibility. When a movement calls for build/release, verified **complete-coverage** DEAM arousal can apply a **maximum 16% soft ordering influence** to the already returned eligible candidates. It never introduces an ID, hard-filters a track, uses partial scores as facts, or forces a `searchJoint` call. Random and explicit playlist/discovery routes opt out as appropriate.
- Station direction is distinct from request conversation history. Model output and request text cannot alter audio settings, credentials, no-play filters, album locks or show playlists. Explicit admin steer is separate from publicly submitted listener text.

## Admin API (existing admin authentication required)

- `GET /dj/steer` — `{enabled, direction}` (current show-scoped view).
- `POST /dj/steer` — validated, strictly whitelisted body:

  ```json
  {"kind":"pivot","intent":"Ease toward textural psychedelic music","scope":"current-show","durationMinutes":40,"followingTracks":8}
  ```

  `kind`: `pivot | hold | lift | release`; `scope`: `current-show | fixed-duration | station`. The station-scoped directive lasts until cleared; other scopes use both duration and start-count limits. The authenticated operator may `DELETE /dj/steer` to clear current musical direction. These endpoints are additive and **disabled with HTTP 409** until the feature gate is on. No new web UI is included in this source change; surface controls only after separate UI review.

- `POST /dj/queue-track` with `{"id":"...","title":"...","placement":"next"}`: explicit highest-priority request. Response reports `next-feasible` only when the new mixer lane has been negotiated, otherwise retains `append` (legacy FIFO). With the feature off, ordinary append behavior stays intact.

## Critical lifecycle / invariants

1. **Listener admitted** ⇒ pending reservation/authority epoch. No phantom song, steering or audibility claim.
2. **Listener resolved + accepted by Queue.push** ⇒ a real queue item + lane if mixer has version 1. Blocked, duplicate and chat-only requests release the reservation.
3. **Ready for actual playback** ⇒ separate lane handoff; cancelling a formerly queued AI request by RID is best-effort and may fail when already prefetched.
4. **Mixer metadata actually starts** ⇒ item is matched by its exact private queue token. Only *verified* listener/operator sources can advance an authoritative musical anchor; matching a name or an ID is insufficient.
5. **Controller restart** ⇒ direction sidecar restores only committed state; speculative pending movement is discarded, and mixer-stamped stable start identity prevents the same still-airing song from being counted twice. Listener reservation recovery uses only successfully queued records; unresolved in-memory resolutions cannot be claimed recovered.
6. **Show changes** ⇒ current-show human intent and soft movement do not leak into the next show. Station-scoped admin directives persist. All automatic song choices still obey the new show's strict eligibility.
7. **Fallback/LLM outage** ⇒ existing deterministic audio playback continues. No new provider, model or subscription-sharing change is part of this patch.

## Qualification — mandatory on the user's Fedora host before activation

The authoring container does **not** have complete controller dependencies, a Liquidsoap binary, the live Docker/systemd setup, or the host's private runtime state. Do not declare these checks passed based on isolated tests.

1. In a **clean isolated checkout** obtained from the bundle, establish the exact Git commit/tree and compare to the **actual live controller**, which had a *post-bundle* provider hotfix commit `3bfb7fac84eec682ffa8b65cf87169fad66df195`. The uploaded baseline **omits** that hotfix. The 1,024-token cap was proven ineffective; owner previously asked for it to be reverted. Reconcile that later commit deliberately instead of overwriting deployed source by guessing image tags. Pin exact current live controller and broadcast images and rollback targets.
2. `cd controller && npm ci && npm run typecheck && npm run lint && npm test`. Focused tests added here: `scripts/mi-v23-direction.test.ts`, `scripts/mi-v23-priority.test.ts`, `scripts/mi-v23-ranking.test.ts`, `scripts/mi-v23-store.test.ts`. Do **not** relax tests/expectations to make the suite pass. Report any exact baseline inherited failures separately from new regressions.
3. Validate the **real Liquidsoap 2.4.x** `radio.liq` parse/runtime in an isolated mixer with controller feature **off**. Verify `music_priority_version`, both lane `.queue` and `_remove` commands, polling order, resolved/unresolved request lifecycle and metadata `subwave_queue_token`, `subwave_clip`, `timestamp`. Confirm intact MP3 320 kbps/44.1 kHz stereo, crossfade, Icecast burst, voice-disabled music-only operation and unchanged source/stream topology. **Do not substitute mocked telnet or unit tests for this gate.**
4. Feature **on**, pre-populate an AI-selected successor in normal `dj_queue`. Submit listener B; verify by actual mixer metadata/audio that B is next at the next still-controllable boundary. Confirm exact queued RID removal when available, and explicit safe deferral when already latched. Repeat for admin `play next`, locked album, mixed listener requests whose resolvers finish out of order, one request resolving to chat, blocked/duplicate requests, a very short requested song, a stem-blend clip and two identical track IDs in separate queue copies.
5. Restart the controller while a request is already playing and while another is queued; confirm **no duplicate audible request or false steering anchor**, preserved private state and expiry by actual starts. Restart the broadcast only in an isolated test to see how pending lane requests reconcile; do not interpret an empty `.queue()` as proof something was never prefetched.
6. Observe real *successful* Agent decisions with `SUBWAVE_MUSIC_DIRECTION_V1=1`: actual tool rounds and final pick, suggestion acceptance only on actual start, steering follow-through for 2–4 subsequent tracks, strict show locks, measured Essentia coverage effects, appropriate movement expiry and manual clearing. Never force a listener request in production merely to create audit evidence.

## Sequential deployment / rollback authority

**No image is built or deployed by this bundle.** Follow the existing protected versioned deployment process on the user's host, not the pre-C5 legacy pin. Stage one **broadcast** image containing the priority sources with the controller's new flag **off**; prove unchanged audio and probes. Stage two controller image containing the new source with flag **off**; confirm parity and matching image/Compose contracts. Stage three set `SUBWAVE_MUSIC_DIRECTION_V1=1` through a versioned, candidate-aware controller guard and bounded healthy readiness; capture rollback files and old service units first. If any stage fails, restore the exact prior image and configuration; never force-recreate unrelated services or discard live state without its corresponding rollback snapshot. Clear/stabilize unconsumed priority-lane handoffs before disabling this feature or reverting broadcast so no stale requested song can play unexpectedly after rollback. Keep old images locally. Do not force picks, trigger extra LLM calls, or change authorization/account provisioning during qualification.

### Authoring evidence and limitations

In the isolated authoring environment, **14/14 focused executable tests** passed for the pure direction/priority/ranking/state-store parts, `git diff --check` passed, and the TypeScript parser found no syntax errors in the 20 changed/new TS files. Dependency installation timed out and left empty package placeholders; **full controller lint, real TS typecheck, overall suite, Liquidsoap parse, native mixer behavior, container builds and live tests were NOT qualified**. Do not report this patch as production-ready or physically verified until those gates pass.

The bundle is Git transport; it does not push the owner's private Git remote. With only the uploaded bundle there is no remote configured in the isolated source checkout. The single local OpenCode agent should fetch the bundle into its existing thread, reconcile actual live post-bundle changes, run qualifications, commit any strictly mechanical adjustments only, and push using the user's existing remote permissions. Any semantic/contract ambiguity must be escalated rather than independently decided.
