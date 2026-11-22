# MI v2.5 — Verified Trajectory Engine (source handoff)

Source parent: `df90c8e8c9f60758142d83e66e7d1866199c6aae`, the exact published MI v2.4 HEAD. This is an additive, feature-gated controller + dashboard change, not a new scheduler, a model, or a show-writing project.

## Activation

Requires all three flags: `SUBWAVE_MUSIC_DIRECTION_V1=1`, `SUBWAVE_MUSIC_DIRECTOR_V2=1`, `SUBWAVE_MUSIC_TRAJECTORY_V1=1`. With the new flag absent, v2.4 retains its prompts, tool results, scoring, and API response fields. Do not enable on production before controller/web qualification and an approved version-pinned release. Keep the live v2.4 rollback images, state, broadcast, drift monitor, and other MI flags intact.

## Authority and evidence

- **Actual starts only:** up to eight latest verified, same-show starts (private mixer-derived identities) may be read in one `lookupV2` request. Pending/queued picks never contribute. Unmatched/invalid profiles are absent, not zero.
- **Measured acoustic progress:** complete-window Essentia arousal, valence, and danceable model outputs support a bounded trend. A trend needs at least three valid actual observations for its dimension. `build`/`release` can report arousal *alignment* or *divergence*. `hold`/`contrast` has no invented numerical destination. There is deliberately no “% to musical destination”; semantic textual destinations cannot be measured from these scores alone.
- **Per-picker cache:** 45 seconds; invalidated by a changed verified-start identity set/show/direction. Missing socket or stale context is a clean no-op. The source reader keeps its existing 12-ID physical envelope and deadlines.
- **Look-ahead:** two optional, *uncommitted*, two-step possibilities (“continuity” and “contrast”) may be evaluated only among already eligible, already surfaced tracks with at least two comparable complete acoustic dimensions. This does not reserve a second track, overrule the Agent, or assert musical superiority. A score adjustment has at most 12% influence on the already-selected candidate order. The Agent's information is additive; it may still choose surprise or another discovered candidate.
- **Wider retrieval:** `tracksByMood`, `tracksByEnergy`, and `searchBySound` can each trigger the same shared, verified joint-search machinery. At most **one** probe is allowed per Agent pick, and only for `build`/`release` with at least 14 eligible source candidates. The primary joint preference uses the explicit arousal direction; a verified predecessor can add a 0.25-weight valence-polarity continuity preference, without inferring the meaning of a free-text destination. It searches a **64-ID eligible source cohort before the normal 12-track tool cap**, with a 1.4-second end-to-end deadline and only 12 verified ranked results. The cohort was already hard-filtered for active show/playlist, recency, track duration, and other existing constraints. Search results must be subset-verified; incomplete, stale, unavailable, or verification-limited result = no rerank. Influence on shortlist composition is at most 10%. This is NOT a claim of 28k-track exhaustive search; the existing specialized `findByAudioTraits` retains the full-cohort/paged route.
- **Shared Agent/Pool evaluation:** after each respective eligible shortlist is formed, both paths can use the same conservative forward-path ranking on complete evidence. Pool never adds a song, changes a lock or requests another LLM just to plan.
- **Admin UI:** `/dj/steer` includes the optional read-only cached trajectory snapshot when the v2.5 flag is on. The dashboard displays measured arousal trend or a missing-evidence message; it does not solicit ratings or add writes. Existing steering controls retain their exact contracts.

## Safety and non-goals

No new migrations, dependencies, public API endpoints, full-audio scans, background tasks, lyric retention, listener profiling, ratings, show descriptions, per-show artistic profiles, or audio/mixer changes. No permanent future-song itinerary. Inference is an estimate of measurable acoustic dimensions, never aesthetic truth. If coverage is low, the program plays normally using the existing v2.4 path.

## Source qualification before rollout

1. Apply on the exact v2.4 parent; verify scope/lock preservation, typecheck and lint controller/web.
2. Run `mi-v25-trajectory.test.ts`, existing v2.3/v2.4 direction tests, selection/mixer identity and strict-playlist tests. Compare any full-suite failures with the exact v2.4 baseline, without test relaxation.
3. Verify a disposable admin GET: v2.5 off omits trajectory fields; v2.5 on may return `measuredTrajectory:null`. Unauthorized GET remains 401 and no picks are triggered.
4. With a fabricated, offline Essentia fixture, check the 64-ID cap, one-probe-per-pick, invalid/off-cohort rejection, verification-limited fallback, and max 10% cohort scoring.
5. Publish an isolated source branch; use a new version-pinned image/contract for a separately authorized production release. Preserve deployed web customizations, never rebuild the public site from an unmerged branch by default.

## Known limits and next editorial work

This is a bounded **source-cohort** extension, not an exhaustive CLAP+Essentia multi-path search over the entire catalogue. Path evaluation uses already eligible options, not promised next songs. Arousal alignment is not a measure of satisfying the movement's semantic destination. Future work can expand evidence-backed CLAP destination matching and offline shadow replay, but it requires explicit provenance, quality gates and cost accounting. No human feedback buttons or show-description edits are part of this release.
