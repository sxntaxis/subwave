# MI v2.4 — Adaptive musical direction and owner console

Source base: `37869c3306f8915e994bf3d3cef728270a7e903c` (MI v2.3).

## Authority and activation

`SUBWAVE_MUSIC_DIRECTION_V1=1` continues to enable the existing station-local direction store. The new behavior requires **both** that flag and `SUBWAVE_MUSIC_DIRECTOR_V2=1`. When the latter is absent, the existing MI v2.3 model output shape, scoring switches, pending-proposal matching, and direction prompt wording are preserved. The additive admin card can still display v2.3 state but labels whether the adaptive director is active.

Authority order remains: hard blocklist and show/playlist eligibility; accepted human requests/operator queue precedence and admin steering; autonomous musical intentions; model score hints. Neither a model movement nor admin text authorizes bypassing a show's strict selection locks. The existing request/mixer priority lanes, locked-block rule, queue identity, ~10-second crossfade and music-only station output are not modified by this patch. A request changes the future course only after its exact actual start is verified. Existing user-visible show descriptions and per-show editorial profiles are explicitly unchanged.

## What changes in the controller

- **Verified progression:** the current movement keeps bounded `progress` (starts, elapsed minutes, distinct artists, phase and alternate musical possibility). The `next` intent can be revised after another verified pick. A `resolve` or `reroute` decision closes the current movement, records its next-step and alternative as a bounded handoff, and allows the next verified Agent pick to establish a new one. Neither a queued nor a rejected candidate advances it.
- **Exact Agent attribution:** a speculative movement or development is bound to the accepted queue's private 32-hex token, the chosen track ID, current authority revision and show ID. A same-ID song from another queue item cannot activate it. Pending data is process-local and deliberately discarded on restart. An unmatched actual start clears it, never fabricates a movement. A new human action immediately supersedes pending autonomous state.
- **Show context:** `incomingShowPhase` reuses the canonical show-boundary resolver, giving the picker opening/development/closing, minutes since the last boundary, minutes until the next change, and next show key where known. A proposed 15–40-minute movement is rejected when less than 15 minutes remain, and otherwise bounded to the remaining show airtime. No new boundary/cue-out policy is introduced.
- **Verified editorial memory:** optional fields in the existing private `music-direction-v1.json` keep at most 48 recent actual starts and 12 movement outcomes. Show-local summaries distinguish previous-show material, artist breadth, repeated tagged moods and tagged-energy trend. No LLM-only "heard" claims, no new source of truth for show identity, and no long listener message/conversation persistence.
- **Future alternatives:** the same Agent may return an optional `development` alongside a normal one-track pick: `continue`, `resolve`, or `reroute`, a next editorial step, and an alternative direction. This is a modest receding-horizon choice, not a preloaded multi-track playlist. A valid play activates the proposal; a failed/overridden play does not. The Agent may finish a trivial continuation quickly; no fixed number of discovery calls or artificial delay is imposed.
- **Musical evaluation across pathways:** existing acoustic transition/novelty selection is enabled for valid Agent and Pool contexts. All Agent tools continue applying eligibility **before** enrichment/ranking. Both Agent and Pool have bounded, optional complete-coverage Essentia arousal ordering within their existing candidate shortlists (16% maximum weight). CLAP remains the existing similarity engine; missing acoustic data is neutral and never blocks play. This deliberately does not force a full-catalog joint search for every song.
- **Observability:** sanitized `direction.proposal`, `direction.airplay`, `direction.admin`, `direction.cleared`, and `direction.human_admitted` events. These carry lifecycle facts, not song titles, auth material or instruction text. The daily event log must remain writable by the controller UID; logging problems must be surfaced separately from musical behavior.

## Admin dashboard

`web/components/admin/dash/MusicalDirectionCard.tsx` is mounted in the existing admin dashboard. It reads `GET /dj/steer` at a low polling rate and displays the live movement, destination/next, verified progress, alternate path, show phase, actual-play summary and active human steering. Operator guidance uses the existing authenticated `POST /dj/steer` (`pivot`, `hold`, `lift`, `release`; current-show, fixed-duration or station scope). Clear uses the existing authenticated `DELETE /dj/steer`, with two-step confirmation. No new public endpoint, new authentication path, auto-pick request or playback control is added.

## Sidecar and rollback contract

The persisted schema version remains `1` because all added fields are optional. Older v2.3 state files load with empty editorial memory and no progress. Disabling `SUBWAVE_MUSIC_DIRECTOR_V2` restores the older reasoning pathway; optional fields do not change v2.3 playback semantics. No SQLite migration or backfill. Atomic replacement, `0600` private file mode and human authority revision remain as in v2.3.

The controller and dashboard are a paired release. Activate v2.4 only after source diff, controller typecheck/lint, web typecheck/lint, focused lifecycle tests and authenticated admin UI/API verification on a disposable runtime. There is **no Liquidsoap source change** in this patch, so the existing MI v2.3 priority mixer remains the compatible playback boundary. Preserve the exact deployed MI v2.3 images as rollback targets and keep v2.4 off until the new controller is healthy. Never fabricate production requests/picks for qualification.

## Known boundaries (do not overclaim)

- This is adaptive, **one track at a time**; it is not a deterministic multi-track itinerary or an offline AI training system.
- Movement `progress` is factual airtime and diversity, not a quantitative proof that a sonic destination has been reached. The optional editorial development decision is model-mediated and only committed on proven playback.
- Tagged-energy trend uses catalogue bands and requires at least three known values. It is **not** Essentia arousal, and partial/missing coverage never implies calmness, stagnation or a failure.
- Acoustic search still retrieves candidates through the existing tools. The shared evaluation changes candidate ordering within eligible pools, not global catalogue recall. For a future full-catalog route we would need a separately audited eligibility-preserving search contract.
- Broad station rotation/novelty remains in the existing library and recency machinery; the 48-start ledger is bounded local editorial context, not a replacement analytics database.
- A scheduled show change removes an old show movement and keeps cross-show history as factual handoff context. Admin steering can span shows only under its existing authorized scope. Show-specific creative profiles and detailed show descriptions are deferred.

## Acceptance / failure cases

1. v2.4 flag off: original v2.3 schema, prompt semantics, playback ordering and state lifecycle remain unaffected.
2. New show / insufficient remainder: no overlong new movement; existing locked playlist/strict constraints unchanged.
3. Accepted AI pick: only a matching queue token + track ID + show + authority revision on a real mixer start can activate/change an autonomous movement.
4. Listener request admitted during an AI pick: authority revision invalidates speculative state; actual requested song starts the bounded human anchor; later autonomous proposals cannot supersede an active anchor.
5. Admin operator directive: remains authoritative for its configured scope, regardless of a model output.
6. Missing CLAP/Essentia/candidate coverage or planner error: existing candidate order/fallback can keep music playing without relaxing strict locks.
7. Restart: persisted movement/verified history survives, speculative pending pick does not; a replay of the same mixer event ID does not increment progress twice.
8. Admin UI: authorized status polling and guided POST/DELETE actions work; unauthenticated requests fail; no browser-side direct playback or selection call.
