# The Lab V6-R2 Implementation Report

## Repository

- Pre-edit repo: `/mnt/Ginebra/Lab/stella.services/data/subwave`
- Branch: `sxntax`
- Pre-edit HEAD: `d28196f689ecc67488b2c2b1fa455fb36e6a848e`
- Origin: `https://github.com/sxntaxis/subwave.git`
- Pre-edit status: clean; `origin/sxntax` matched HEAD
- The pre-existing semantic-runtime commit was left unchanged.

## Architecture

V6-R2 is an additive station-pack projection. `THE-LAB-V6-R2-UMBRELLAS.json`
contains eight stable umbrella IDs, exact public names, and the complete
subshow-to-umbrella mapping. The schedule remains an hourly grid of existing
runtime show IDs. `s_freeform` is explicitly station flow and has no umbrella;
`s_b_sides` remains defined in the manifest but is explicitly unscheduled.

Umbrellas contain no genres, moods, crates, picker fields, or repertoire
filters. Consumers can resolve a subshow through `subshow_to_umbrella`, render
umbrella blocks by joining that mapping to schedule entries, and group adjacent
same-umbrella entries without changing selection inputs.

## Schedule Certification

`THE-LAB-V6-R2-SCHEDULE.json` contains seven 24-entry day arrays: 168 hourly
slots, with no gaps or overlaps. Every slot references an existing manifest
show ID. The resulting weekly hours are:

| Show | Hours | Show | Hours |
| --- | ---: | --- | ---: |
| Absolute Cinema! | 2 | After Hours | 10 |
| Afrodisiac | 2 | Amplified | 1 |
| Atmospheres | 14 | Blue Suede | 1 |
| Chingoteo | 1 | Crossroads | 1 |
| Distorted | 3 | Folkside | 4 |
| Freeform | 22 | Funkplay | 6 |
| Garageware | 7 | 한류 | 1 |
| Hazey | 8 | Hellfire | 2 |
| Housebrew | 9 | Hustlas | 3 |
| Hyperbeats | 3 | Lowkey | 7 |
| Lowriders | 4 | Movements | 3 |
| Neobop | 3 | Natural Mystic | 3 |
| Offbrand | 11 | Palenque | 1 |
| Parranda | 1 | Postwave | 2 |
| Riddim | 2 | Rustbound | 1 |
| Signals | 4 | skrrt | 1 |
| Softsynth | 9 | Standards | 2 |
| Swingtime | 3 | 都会の歌 | 3 |
| Tropicalia | 4 | Tumbao | 1 |
| UFOs | 3 | B-Sides | 0 |

Weekend certification is complete contiguous Saturday/Sunday coverage with no
B-Sides slots. Unicode round-trip checks cover exact `한류` and `都会の歌`.

## Tests and Checks

- Focused station and existing crate tests: **17 passed**
- Controller typecheck: **passed**
- Controller lint: **passed**, 0 errors and 717 existing warnings
- Controller schedule-filtered suite: **117 passed**
- Controller picker-filtered suite: **16 passed**
- Semantic and transition regression scripts: **passed**
- Full `npm test`: **not clean**; the existing all-suite runner reported 232
  cancelled tests with `Promise resolution is still pending but the event loop
  has already resolved`.
- Direct `playlist-exhaust.test.ts`: **16 passed, 1 existing failure**; its
  source-shape assertion does not match the already-present semantic picker
  change. No picker change was made for V6-R2.
- JSON parse and `git diff --check`: **passed**

## Runtime and Production Safety

- Picker semantics changed: **no**
- Crate authority changed: **no**
- Existing picker/controller files changed by this implementation: **none**
- CLAP, Discogs400, moods, Moments, metadata, semantic ingestion, and audio
  analysis changed: **no**
- Production mutations: **0**
- No schedule write, show write, Navidrome write, database write, scan,
  analysis, restart, redeploy, or cutover was performed.

## Diff and Delivery

- Files added: the V6-R2 schedule, umbrella mapping, certification test, and
  this report.
- Files modified: none.
- Mechanical fixes: **NONE**
- Commit SHA: recorded in the final delivery status after commit creation.
- Final tree SHA: recorded in the final delivery status after commit creation.
- Push status: pending commit verification.
- Bundle: created after the authored commit; SHA-256 recorded in final status.

This is an authored review artifact only. Production remains on the current
live schedule pending a separate cutover gate.
