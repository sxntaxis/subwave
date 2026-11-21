# MI evidence context probe — handoff

**PASS_RICH_CONTEXT_OFFLINE_EVIDENCE** · source `48b7a8a21e19580ea9251b4963dda422d0e56e6c`, tree `abbd3d1c26c058d8c0cfe42ce96c6b0d026230fd`, parent `b5da7ac07ced08d81170fb9466af1bd1c9fd4341`. Offline deterministic probe only; no v3/production DB, live picker, provider, audio, or station was touched.

## Source-to-Agent trace

Paths below are relative to `controller/`. “Discovery” and “comparison” mean tool return payloads available to the agent when the relevant tool is registered and called; no provider-specific receipt is claimed.

| Evidence | Stored | Socket-returned | Compacted | Discovery exposed | Comparison exposed | Absent / caveat |
|---|---|---|---|---|---|---|
| Identity, trust, freshness | `scripts/music-evidence-index-v2.py:28-49,92-153`: evidence identity/provenance, window and raw output rows, plus aggregate head summaries. | `src/music/music-evidence-index-v2-reader.mjs:124-189`: requires one ready analysis, matching model/provenance/source identity and stat freshness; returns the requested ID and its windows. `src/music/essentia-evidence.ts:51-66,69-99` bounds/validates lookup; no paths are sent by the client. | `src/music/music-evidence-profile.ts:40-61` removes IDs, run/source stamps, raw window metadata, and unselected outputs from the LLM profile. | Attached only with `essentiaDiscovery`, `SUBWAVE_MUSIC_EVIDENCE_V2=1`, a live reader, 1–12 unique returned IDs and remaining budget (`src/llm/internal/tools/picker/scope.ts:396-428`). | `compareMusicalCandidates` is conditionally registered under the same flag/reader gates; only 2–4 distinct prior-discovery IDs (`.../tools/compare-musical-candidates.ts:7-13,30-43`). | No private track IDs or source paths in this report. A failed trust/freshness/identity check yields no profile, not guessed evidence. |
| Windows and native outputs | Index retains each segment’s bounds/role, measurements/quality JSON, raw value, native scale, missing reason and validity (`scripts/music-evidence-index-v2.py:35-44,128-140`). Up to five non-overlapping 10s samples are provenance-checked (`src/music/music-evidence-index-v2-reader.mjs:165-169`). | Reader returns window `startMs/endMs/role`, `measurements`, `quality`, and per-head `{modelId,label,value,nativeScale,missingReason,validity}` (`...reader.mjs:174-189`). | `MusicEvidenceV2` statically types `outputs` and window bounds/role, but not `measurements`/`quality` (`src/music/musical-evidence-v2.ts:3-28`). Compact profile emits sparse-window disclaimer and only selected summaries (`music-evidence-profile.ts:50-60`). | Compact fields: instrument/mood heads, danceable, voice, bright-timbre, DEAM arousal/valence. Instrument and mood are top-four after validity/complete-window filtering (`music-evidence-profile.ts:10-37,40-61`). | For each candidate: compact profile plus predecessor-ending→candidate-opening deltas/coverage for arousal, valence, instruments, voice, timbre (`.../tools/compare-musical-candidates.ts:48-60`; comparison math in `src/music/musical-evidence-v2.ts:92-164,167-249`). | Window measurements/quality, raw per-window trajectories, most raw outputs, provenance and native scale strings are not included in compact LLM payload. Missing/invalid/incomplete remain represented as status/null in the existing summaries, not invented values. |
| Discovery envelope / other musical context | — | Socket profile lookup accepts ≤12 IDs; socket replies cap at 2 MiB (`src/music/essentia-evidence.ts:51-66,90-99`; `src/music/essentia-socket-server.mjs:98-100`). | Per-pick evidence ceiling 32 KiB; discovery reserves at most 8 KiB and divides it evenly; it pops instrument/mood labels until a profile fits, otherwise omits the whole profile (`src/llm/internal/tools/picker/scope.ts:184-195,396-417`; `src/music/music-evidence-profile.ts:64-89`). | `collectAsync` defaults to 8 results; valid tools can supply explicit caps; eligibility and all existing recency/show/playlist/blocklist filtering remain in force (`scope.ts:238-252,420-428`). `slim()` already conditionally includes genre/year, editorial moods/energy, duration, vocal status, BPM/key, intro, pace/sections and play/artist recency (`src/llm/internal/tools/picker/slim.ts:13-25,38-99`). | Comparison reserves up to 16 KiB, may append a verified predecessor to lookup, and returns unavailable if actual JSON exceeds its reservation (`.../compare-musical-candidates.ts:34-75`). | Audio trait search returns IDs/candidates, not its internal profile rows; it is conditional on an available reader and v2 joint search additionally on the feature flag (`.../tools/find-by-audio-traits.ts:9-13,37-100`). Do not confuse lack of Essentia compact fields with absence of BPM/key/editorial or recency fields already in `slim()`. |

**Model-path qualification.** `dj-agent.ts:263-290,295-299` passes scope and `session.windowMessages()` into the agent; event text names the current track and optional previous title/artist (`dj-agent.ts:868-879`). The vNext selection context, only when `PICKER_VNEXT_AGENT=1`, can supply a verified predecessor and up to five same-show aired IDs (`dj-agent/selection-context.ts:6-28`). Compare uses the predecessor only when that context exists. Tool registration filters each tool’s `available` gate (`llm/internal/tools/picker/index.ts:84-94`); provider discovery-step count depends on that leg and its capability/override (`llm/internal/provider/capabilities.ts:201-239`; `llm/internal/strategy/agent.ts:268-275,376-404`). These establish code availability, not that a particular model/provider called either tool or received a specific result. One-round/no-tool legs cannot be assumed to see tool-returned evidence.

## Offline measurements

`scripts/music-evidence-context-probe.ts` calls production `compactMusicEvidence`, `attachCompactMusicEvidence`, and the production comparison tool’s `execute` with a fake lookup/reservation. IDs and labeled fixtures are synthetic. Byte counts are exact UTF-8 `JSON.stringify` bytes, **not token estimates**. Discovery payload totals include the synthetic base track fields; `evidenceBytes` is the production serializer’s counted profile bytes. Instrument/mood truncation separates top-four compaction from per-song-share reduction.

| Results | Shape | JSON bytes | Evidence bytes | Songs with evidence | Labels dropped I/M: top-four; share | Omitted profiles |
|---:|---|---:|---:|---:|---|---:|
| 2 | full | 2,110 | 1,853 | 2/2 | 0/0; 0/0 | 0 |
| 4 | full | 4,610 | 4,097 | 4/4 | 4/4; 0/0 | 0 |
| 8 | full | 8,687 | 7,662 | 8/8 | 12/12; 8/8 | 0 |
| 12 | full | 1,565 | 0 | 0/12 | 24/24; 0/0 | 12 |
| 2 | partial | 2,003 | 1,740 | 2/2 | 0/0; 0/0 | 0 |
| 4 | partial | 3,997 | 3,472 | 4/4 | 0/0; 0/0 | 0 |
| 8 | partial | 7,993 | 6,944 | 8/8 | 0/0; 0/0 | 0 |
| 12 | partial | 1,601 | 0 | 0/12 | 0/0; 0/0 | 12 |
| 2 | sparse/invalid | 2,069 | 1,808 | 2/2 | 0/0; 0/0 | 0 |
| 4 | sparse/invalid | 4,137 | 3,616 | 4/4 | 0/0; 0/0 | 0 |
| 8 | sparse/invalid | 8,273 | 7,232 | 8/8 | 0/0; 0/0 | 0 |
| 12 | sparse/invalid | 1,589 | 0 | 0/12 | 0/0; 0/0 | 12 |

12-profile omission is a measured edge: each candidate gets `floor(8192/12)=682` bytes, below even the minimal compact profile in these fixtures. Eight full profiles retain evidence but drop one instrument and one mood label per song beyond the top-four reduction. Partial/sparse rows are smaller because complete-window/head validity gates remove label lists; their status/null coverage remains. This is a deliberately high-cardinality synthetic fixture—not evidence that real tool calls always hit these limits.

| Comparison IDs | Shape | Reservation | Result bytes | Tool status | Budget-caused unavailable |
|---:|---|---:|---:|---|---|
| 2 | full / partial / sparse | 16,384 each | 5,794 / 5,309 / 5,399 | available each | 0 |
| 4 | full / partial / sparse | 16,384 each | 11,684 / 10,581 / 10,761 | available each | 0 |
| 4 | full | 1,024 | 83 | unavailable | 1 |

The comparison tool’s outer `available` means requested candidate profiles were found; it does not mean all nested feature comparisons are complete. At normal reservation no synthetic case exhausted 16 KiB; constrained 1 KiB returned the production unavailable envelope.

**Not measured yet:** private v3 distributions, real profile byte percentiles, actual profile omission rate, real comparison result sizes/status, provider-leg tool calls/latency, and effects on pick quality. These require post-activation authorized samples/telemetry; none were queried here.

## Design handoff (no runtime changes)

Richer final-stage sketch, illustrative structure only; sample roles are sampled positions, **not** inferred song sections:

```json
{
  "source": "essentia_estimate",
  "windowSampling": "sparse_windows_not_continuous",
  "features": {
    "arousal": {
      "nativeScale": "DEAM native [1,9], valence then arousal",
      "coverage": {"valid": 3, "expected": 5, "status": "partial"},
      "samples": [
        {"role": "opening", "startMs": 0, "endMs": 10000, "value": 4.2, "validity": "valid"},
        {"role": "ending", "startMs": 180000, "endMs": 190000, "value": null, "validity": "source_missing"}
      ]
    }
  }
}
```

Ranked information gain per added byte:
1. **Shortlist-only endpoint/window coverage and valid native samples**: recovers direction/variation hidden by means and makes uncertainty actionable. Avoid repeating per-window raw fields the consumer does not need.
2. **Selective extra head labels on request** (beyond current four) with original scores/coverage: useful where discovery surfaced a candidate for a concrete mood/instrument question; top-four can discard relevant labels.
3. **Compact trajectory delta with endpoint provenance**: comparison already computes endpoint changes; expose sample coverage and bounds rather than duplicating both full profiles.

Risks: provider/tool-loop latency and one-round legs may never call the deeper tool; incomplete heads can collapse to null/no labels; sampled windows are sparse evidence, not continuous structure; larger profiles can starve discovery or make comparisons unavailable. Keep strict candidate IDs, show/playlist/request/recency boundaries and null/invalid distinctions. Avoid duplicating `slim()` BPM/key, editorial mood/energy, vocal, pace/sections and recency.

**Recommended v2.1 slice:** add an opt-in, shortlist-only final-stage serializer that returns *only* selected raw per-window samples plus per-feature validity/coverage and native-scale metadata, bounded by the existing comparison reservation; first validate private-v3 size distributions and provider call/latency telemetry. No ranking/Pool policy, discovery contract, prompt, schema, persistence, or activation change is recommended by this experiment.

## Qualification

- Changed files: `controller/scripts/music-evidence-context-probe.ts`, `controller/scripts/music-evidence-context-handoff.md` only.
- Focused checks: offline probe passed using installed dependencies via a temporary resolver symlink to the existing qualified worktree; TypeScript `tsc --noEmit` and `git diff --check` passed; no package install.
- Branch: `terra/mi-v2-rich-context-bench-b48b7a8`, based on the pinned source/tree above; committed locally only. A matching bundle and SHA-256 are supplied in the final handoff.
