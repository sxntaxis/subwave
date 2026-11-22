# MI v3 — Music-only mixcraft and picker continuity follow-up

This follow-up is one source commit **on top of** the authored MI v3 independent editorial Director (`e1b391c6d43a0e4f3e0c1c18315a56f7af8dde94`), whose parent is deployed MI v2.5.1 source `8a72cb8a9fa251412f354eb3cda7d48bb3b423fd`.

## Observed production evidence (read-only, 2026-11-22)

- Active persona `sxntax`: `djMode=false`. All six transition switches, `pairDrain=true` and `stemBlends=true` in settings, but `settings.effectsActive()` and `queue.pairDrainActive()` were false.
- Current `crossfadeDuration=10` is a ceiling for variable pair lengths as well as Liquidsoap's fallback; enabling pair-aware draining can produce shorter crossfades on compatible analysed pairs, not guaranteed longer-than-10 fades.
- 191/191 auditable normal picks named the correct immediately preceding song. Zero held-tail picks were seen; **do not modify the proven normal predecessor path**.
- Latest 20 Agent selections used one `showPlaylistTracks` call with 12 returned candidates each. Day-long discovery was broader; deadline exhaustion was not recorded. Forcing more tools on strict playlists is not the right fix.
- In the last 20 tracks, BPM/key were 20/20, but analysed outros 3/20 and usable stem caches 0/20. This limits ending-specific canvases and rendered stem blends despite enabling mixcraft.

## New policy

`SUBWAVE_MUSIC_MIXING_V1=1` is an independent, reversible **music-audio** feature gate. It enables musical transitions even when the effective persona has `djMode=false`:

1. Picker Agent and Pool may request transitions via the existing schemas and six per-effect switches.
2. Queue validates/arms their effects using existing musical-compatibility, repetition, cap, boundary and human-priority rules.
3. Pair-aware hold and outgoing-track cross-duration stamps are eligible when `settings.transitions.pairDrain` permits them. Renderer remains separately gated by `stemBlends`, actual cached stem windows, compatible grids, and the hard drain deadline.
4. `djMode` still exclusively governs link frequency, DJ mini-runs, persona speaking style and voice budgets. `sfx.enabled=false` remains false. This change does not synthesize voice or add SFX.
5. With mixing flag **off**, all existing v2.5.1 persona-gated transition behavior is preserved, including DJ mode's previous effects.

The change intentionally keeps Liquidsoap's 10-second default and the operator-configured maximum intact. It does not guarantee an audible special transition at each seam; the controller is allowed to choose `normal`, to reject an incompatible effect, or to fall back after a missing/stale pair.

## Predecessor and exploration consistency

When pair-drain selects a song after an **unplayed** queued predecessor, the event prompt now identifies that predecessor as `NOT-YET-AIRED`, names the real on-air song separately, and asks for its successor. Verified historical/Essentia memory is **not** modified or fabricated. We do not pretend that the planned predecessor is a confirmed playback start.

Agent guidance now asks for comparison of two distinct eligible musical continuations whenever possible, even when all 12 candidates came from the single authorized strict playlist tool. It does not force another discovery call, change candidate admission, lift strict constraints, or change the deadline. It must not convert fast legitimate picks into timeouts.

## Operational evidence

The opt-in adds bounded structured events in the existing durable `state/logs/events-*.jsonl` stream:

- `mix.transition.policy`: requested/admitted/rejected kinds, available rejection reason, and track's intended outgoing crossfade length;
- `mix.transition.pair_stamped`: outgoing/incoming identities, chosen crossfade length and whether the shorter ending canvas prevailed;
- `mix.transition.handoff`: track handed to Liquidsoap with planned entry effects, crossfade duration and known-successor/stem-clip status;
- `mix.transition.mixer_start`: mixer-confirmed pair identities, planned outgoing cross duration and expected effect flags, explicitly `audibleEffectConfirmed:false`.

These are **not** measurements of actual audible effect execution or overlap duration. Confirming which radio.liq branch rendered would require separate mixer-origin instrumentation, not inferred queue flags.

## Compatibility and non-goals

No new database migrations, dependencies, model providers, extra AI calls, Liquidsoap edits, public endpoints, voice, SFX, scheduling logic, show filters, playlist locks, user-request semantics, or acceptance-test relaxations. The v3 Director's independent calls and dashboard remain opt-in with `SUBWAVE_MI_DIRECTOR_V3=1`. The optional cultural RSS feed remains off unless configured.
