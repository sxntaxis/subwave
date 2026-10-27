# Follow-up: Lyrics return + song handoff corridor ownership

This follow-up is separate from immutable tag
`phosphoria-baseline-2026-10-27` (commit `e86512bb`).

Owner screenshots showed artwork/title overflowing across progress and controls
after closing Lyrics and changing song. The normal artwork surface is absolute,
so it cannot contribute natural height if its parent corridor falls back to auto.

## Source cause

Two writers shared `trackCorridor.style.height`: the view coordinator wrote it
imperatively, while the song-handoff JSX set a conditional React height prop.
At handoff completion React removed that prop, also removing the coordinator's
height. Its ResizeObserver could already have seen the final incoming content
while writes were intentionally suspended for the handoff, so there was no
subsequent resize notification to restore it. The corridor collapsed while the
absolute title and artwork remained painted.

## Focused correction

- Remove the React height prop completely.
- Keep the view coordinator as the sole writer.
- Song choreography requests temporary extents through a stable callback, using
  its existing safe-height/growing/shrinking phases and duration.
- On settle or cancellation, explicitly release the reservation and reapply the
  current normal height even if no observed content changed.
- Keep song timing/paint, view timing, native lyrics and clocks unchanged.

Modified source files are `SxntaxSkin.tsx`, `lyrics/useLyricsPresentation.ts`,
`lyrics/presentationGeometry.ts` and one new focused nonvisual ownership test.
Typecheck, targeted coordinator lint and 16 nonvisual ownership/state/timing
tests passed before the release build. No browser/visual automation was used.
The screenshot outcome remains subject to owner manual acceptance.

Branch: `fix/phosphoria-corridor-handoff`.
Web image: `subwave-web:phosphoria-corridor-handoff-fix`.
Build from this checkout with `docker build -f web/Dockerfile -t
subwave-web:phosphoria-corridor-handoff-fix .`.
Promote web-only by appending `web.corridor-fix.yml` to the installed stack's
existing overlays, then `up -d --no-deps --no-build --pull never web`.

Fallback remains the baseline `web.override.yml` and archived exact image as
documented in the sibling README. Never move or replace the baseline tag to
include a later correction.
