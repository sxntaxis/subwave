# YouLyPlus v5 source — directly vendored

Upstream: https://github.com/ibratabian17/YouLyPlus, source supplied by user (v5.0.0).
MIT License — copyright (c) 2025 Ibra Al Tabian; see LICENSE.

`lyricsRenderer.js` and `lyrics.css` are the complete upstream animation renderer and style engine, with narrowly documented integration shims (localization fallback, no-seek, no-wake-lock). `dynamicBkg.js` is retained separately because it integrates with site-specific artwork/audio hooks and must not silently replace Phosphoria's existing GPU compositor. It is not activated by this change.

Host bindings, document conversion, timing and lifecycle are in sibling SUB/WAVE adapter files. Never pass `audio.currentTime` of a live Icecast stream as song position.

Standalone-host integration notes (SUB/WAVE P14.1):

- Original YouLyPlus renderer's unqualified `currentSettings` symbols in two
  render helpers have been bound to the instance's settings; the extension
  previously supplied these as ambient state.
- The original options menu uses an ambient provider registry. The radio
  adapter supplies a no-provider registry because Navidrome owns retrieval.
- The reload item is omitted when the host offers no reload callback rather
  than exposing a dead action. Offset controls remain native and functional.
- Native offset persistence calls the host as `(songInfo, offsetMs)`. The
  adapter saves the second argument per track, not the songInfo object.
- The CSS still ships as a selector-scoped copy of upstream for the single
  Now Playing hero; the extension background compositor remains vendored but
  unmounted pending an explicit Phosphoria compositor integration.
- OpenSubsonic v2 extra cue agents and synchronized alternate language lines
  pass via the additive public lyrics document. Backing vocal cues and explicit
  guest voices map to native background/duet structures; translations and
pronunciations align only when line start times match unambiguously.

Native recovery (after P21.x host overrides):

- Compared with owner-supplied upstream archive commit
  `067ed95c0e23da50da70580bd4822ab17c1c78bf` (2026-10-21).
- Native activation/overlap/scroll-primary selection and `_getScrollPaddingTop`
  are restored; no custom per-singer ownership or line-center target replaces
  those methods. The existing final-line end guard and ECO lightweight scroll
  integration are retained.
- The host supplies `--lyrics-scroll-padding-top` in viewport pixels. The
  original `1em + anchor` leading padding is functional scroll runway, and must
  not be forced to zero while the anchor remains nonzero. Plain untimed text
  has no follow runway.
- Native clock input is song-relative consumed-media time with no presentation
  lead. SUB/WAVE preserves station playback/idle accounting before anchoring that
  media clock. A coarse pre-cross marker is not a proven replacement for that
  origin. Never use stream `audio.currentTime` as an absolute song clock.
