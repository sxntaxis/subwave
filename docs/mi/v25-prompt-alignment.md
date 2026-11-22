# MI v2.5 — AI DJ prompt alignment

The radio prompt is not a single template. The conversational Picker receives static, versioned instruction blocks (`controller/src/llm/instructions/*.md`), a composed show/persona system prompt (`broadcast/dj-agent/schemas.ts`), dynamic pick-event context (`broadcast/dj-agent.ts`), discovery-tool descriptions, and the `done` schema. The fallback Pool uses `llm/internal/prompts/picker.ts` and a compact one-shot candidate payload. Listener request resolution has a **separate** request prompt and is not changed here.

## Why this correction is needed

The pre-v2.5 shared criteria were optimized for good *individual* segues: FLOW first, avoid consecutive instrumentals, match weather/daypart, and default to a quick attractive candidate. That biases a long-form radio toward local smoothness rather than intentional multi-song development. The pool prompt also labelled saved/liked songs as proven crowd-pleasers despite the operator's bookmark-first semantics; its one-shot model didn't see the active human steer or movement beyond the scorer's optional energy hint. The discovery prompt said to use available rounds as though using more tools were necessarily better; the single-round and multi-round cases have different actual budgets. Some expanded-tool coaching overemphasized specialized `findByAudioTraits`, although Mood/Energy/Sound discovery now supports a bounded joint-acoustic source probe.

## Versioned fix

All new editorial prompt blocks are **only selected when** `SUBWAVE_MUSIC_DIRECTION_V1=1`, `SUBWAVE_MUSIC_DIRECTOR_V2=1`, and `SUBWAVE_MUSIC_TRAJECTORY_V1=1`. The original text and assembly are preserved with the new flag off. New sections:

- `pick-criteria.md → criteria-trajectory`: ordered authority/show → movement → transition/contrast → rotation → secondary daypart/context. No universal instrumental-alternation, mandated crescendo, or weather-first programming.
- `picker.md → finding-candidates-trajectory`, `finding-candidates-multi-trajectory`, `music-evidence-expanded-trajectory`: honest 1-round vs multi-round budgets; discriminate between a genuine need for discovery and extra calls for their own sake; acoustic search is an available internal augmentation, not a required separate tool; unavailable or incomplete evidence never becomes a negative musical judgment.
- `pool-picker.md → source-tags-trajectory`, `recent-plays-trajectory`, `direction-trajectory`: saved songs are not ratings; recently aired candidates are possible under existing starvation fallback; direction is an authenticated, already accepted state snapshot, not free listener text.
- `likes.favouritesClause(..., asBookmark)` uses weak bookmark wording in trajectory mode without changing the underlying likes storage, ranking, routes, opt-in preference switch, or legacy prompt.
- `dj-agent.ts → music/picker.ts → llm/internal/prompts/picker.ts` passes a bounded projection of **accepted** human steering or an autonomous movement to the *stateless Pool prompt*, so its existing candidate evaluation has the same editorial objective as its conservative acoustic scoring. No new Pool schema fields, extra model calls, or persisted plans.

## Unchanged authority and scope

Hard show/playlist eligibility, request ordering, queue-token identity, admin-vs-listener precedence, the music-direction sidecar, audio mixing and playback, feature flags, and the existing picker output contracts remain as before. The `requestSystem` prompt is deliberately unchanged: raw listener messages are untrusted until accepted by the request pipeline. None of this changes show descriptions or creates show-specific artistic profiles.

## Qualification

- New offline prompt-contract test: `controller/scripts/mi-v25-prompt-alignment.test.ts`.
- Existing verbatim legacy prompt pins: `controller/scripts/instructions.test.ts` remain unchanged and must continue passing.
- Under all three flags on, verify the Agent sees the trajectory criteria and actual dynamic movement context, and the Pool sees its accepted direction without adding an untrusted raw listener message.
- Under `SUBWAVE_MUSIC_TRAJECTORY_V1` absent, verify old prompt wording and source-tag labels are byte-identical to the v2.4 version.
- Complete project tests/typechecks and any live model sampling remain local qualification steps. This patch alone does not claim any improvement in musical taste without observational evidence.
