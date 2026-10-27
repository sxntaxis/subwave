- v42 stabilizes resize and handoff geometry: cover size interpolates across the synchronized handoff, hero scale is capped, artwork/AIR share one clipped rounded frame, the scrollport keeps scrolling without visible chrome, and the outer SVG frame tolerates viewBox/CSS resize skew.
# sxntax skin

Brand face for `radio.sxntax.shop`.

## Boundary

Presentation only. The skin consumes the existing PlayerCore feed/audio/actions,
`useTuneInGate`, and shared skin hooks. It does not alter queue, playback,
request, persistence, or controller semantics.

## Visual contract

The experimental startup diagnostic console is disconnected from the public
skin: no `[ WAIT ]` / `[ OK ]` / `[ WARN ]` lines, idle-gate text or diagnostic
retry buttons, and no skin-mounted audio-signal diagnostic probe. Startup uses
the minimal frame/readiness gauge and normal Tune In controls.

Animated identity layers occupy the same CSS grid cell as the semantic title:
row 1 in landscape, row 2 below the artwork in portrait. The bridge has zero
intrinsic height, so it follows the actual cover size/gutter without affecting
the fitted layout. Landscape's animated two-column rule is landscape-only.
The first real metadata after an empty cold load commits directly instead of
animating from “Somewhere on the dial”. Browser regression coverage is in
`web/scripts/verify-sxntax-track-transition.mjs` (isolated server and fixture APIs).

During the schedule modal, only page copy is hidden: the outer Ratatui frame and
un-dimmed live ambient remain. The weekly current-time rule starts at the
centered hour rail, which carries 24 aligned small dots and highlights the
current-hour dot instead of adding a second marker. The close glyph is the
subsetted Nerd Font `fa-times` (`U+F00D`); its font URL revision advances with
the subset so installed browsers cannot keep a prior font missing the glyph.

The schedule grid defines 24 shared `minmax(hour, max-content)` tracks. Hours,
dots and every day subgrid use those same tracks; expanding a description grows
the selected hour across the week, so later shows move together rather than
being covered. The current-time rule measures against the actual current-hour
track after that growth (never a fixed percentage of the original day height),
verified at 21:00 and 21:20. Hour labels are centered on the dots; a transparent
gap protects a label only when its measured vertical bounds intersect the rule.
Between labels the rule is continuous, and it remeasures after grid/font resize.
Portrait uses the same grid and rail, not a differently scaled agenda.

Cards always show their start/end range and topic, without host names. Full-text
fit is measured at the visible description width against the actual inner height
of the scheduled span. When the text fits, it is shown immediately with a small
bottom cushion; otherwise, the preview shows as many lines as the slot can hold,
rather than imposing a fixed line count. Clicking the whole card expands the
hour tracks to fit the full description with a restrained 10px maximum bottom
cushion. The expansion is quick and smooth, and pushes later hours down rather
than floating over another show. The current-time rule is one straight line,
snapped as a whole to the nearest measured text-line gap clear across all days.
Readability takes precedence over exact minute position. Transparent cards cannot
hide a rule through layering alone. Text clearance remeasures on scrolling,
resizing and font loads.
Hour dots match the rail color; non-current dots are subdued and the current dot
is full-strength without a halo. The hour rail has a small top inset so the
00:00 label is not clipped, while day dividers extend to the header edge. Hover
has no box outline. The close
glyph has an unbordered
44px target. The live-show summary shares the main header with Schedule, and
popup insets are derived from the outer frame's safe area to stay distinct at
different zoom levels.

- vertical-first single-page radio surface
- Ratatui-style viewport frame with a station-zone clock
- `DiGrotesk-Regular.woff2` for expressive type and `3270 Nerd Font` for system text
- Kawarp full-surface cover ambience with Kawarp dithering disabled; CRT owns screen texture
- adaptive pure-black/pure-white foreground with luminance hysteresis
- Kawarp luminance is constrained by foreground polarity; no reading-field gradient
- interactive hover/focus is strict black/white inversion, never palette color
- small album-art plate aligned to the top of the track title; artwork never becomes UI chrome
- CRT screen-space modulation, no curvature
- retained-target smooth wheel scrolling matches the sxntax.shop interaction model
- track titles are viewport-fitted without an arbitrary line-count ceiling; ellipsis is a last resort
- Dear DJ appears immediately after the listening hero, with a wrapping three-line composer
- request acknowledgements put `NEW REQUEST` beside the `DEAR DJ` heading
- NOW PLAYING, DEAR DJ and AIR share one section-tag component, typography and left alignment
- one AIR surface combines NEXT, NOW, the last 100 played songs, per-airing DJ pick reasoning, and retained spoken DJ turns
- controller/system pick prompts are not repeated in the public log

Pick reasoning travels with each queue/history entry as `reason`; repeated plays
of one song keep their own comments. Older controllers fall back to the explicit
`meta.trackId` → `subsonic_id` session join. Spoken turns remain standalone
timeline entries, sourced from `/state.airMessages` and held until audible with
the listener buffer. This persisted station-wide speech history survives session
rolls and page reloads; the live `/session` tail is only a compatibility fallback.
The 100-song limit does not include NEXT/NOW, and speech does not consume song slots.

The current show in the station line is the schedule trigger. It shares
`routeLink`'s monochrome hover/focus inversion, with no underline or icon.
`ScheduleModal` is lazy-loaded on intent/open and fetches `/schedule` only while
mounted. Its portal lives inside the skin root so the current Phosphoria colors,
fonts and contained-preview bounds are inherited. Portrait presents a day agenda
with weekday navigation; landscape presents a seven-column weekly timetable.
Times use the explicitly labelled station timezone, midnight remains a day
boundary, and a temporary takeover is distinguished from the regular programme.
Radix owns modal focus/Escape/outside-click handling; player shortcuts stand down
while it is open. `scripts/verify-sxntax-schedule.mjs` drives the real production
UI against fixture APIs, including rotation, retries, takeover and theme polarity.

When no cover is available the skin falls back to the active theme's `--bg` / `--ink` tokens.


## v4 geometry pass

- Native presentation scale increased again toward the operator's preferred browser-120% density.
- Hero no longer reserves a full viewport, eliminating the dead band before Dear DJ.
- Long-title marquee triggers only when measured wrapping truly exceeds two lines; normal two-line titles keep their full layout width.
- Title line boxes leave descender room so characters such as `y` are not clipped.
- Album art remains top-aligned with the title and disappears on cover load failure.
- Dear DJ owns equal full-width section separators; its composer rule is deliberately shorter, with SEND dropping below it under the container breakpoint.
- Tune-in gate is an inline terminal action over the live page rather than a blurred/full-color modal treatment.


## v5 presentation corrections

- Tune-in gate uses one seamless full-surface backdrop blur/frost; no visible modal pane.
- Hero again reserves one complete viewport, with header, now-playing body, and controls distributed across it.
- Track titles use a two-line responsive clamp with ellipsis instead of marquee motion.
- CJK titles use a dedicated CJK system-font stack to avoid mixed-script baseline/metric drift.
- Top station metadata sits closer to the Ratatui frame.

## v6 hero fitting

- The now-playing title is measured against its real rendered width and loaded font.
- The title first scales down only as far as needed to fit within two lines.
- If it still cannot fit at the minimum readable size, the actual string is shortened and receives a clean ellipsis; CSS line-clamp is not used.
- The fitter reruns on track changes, ResizeObserver geometry changes, font readiness, browser zoom, and VisualViewport resize.
- The hero remains full-viewport, while the now-playing composition is bounded so artwork stays visually attached to the title rather than pinned to the far edge.
- AIR LOG always carries an explicit NEXT row. When no upstream item exists yet it renders `selecting…` rather than disappearing.

## v7 golden-ratio hero geometry

- Removes the title line-count ceiling. The title fitter now solves against the physical vertical room left inside the hero, so titles may occupy as many lines as the composition can support.
- Ellipsis is used only after the complete title cannot fit at the minimum display size.
- Title, artist, album, system copy, controls, and artwork share one measured hero scale rather than independent static clamps.
- Hero spacing is derived from one fluid unit and the golden-ratio ladder (`1`, `φ`, `φ²`, `φ³`, `φ⁴`).
- Residual viewport height is distributed center-out with `φ : 1 : 1 : φ` springs, so zooming out expands the composition away from its center instead of pinning header/content/controls to top/middle/bottom.
- Header, progress, metadata, and controls now share one centered hero stage, eliminating the former 1240/1080 width mismatch and right-padding bias.
- The title/art cluster uses measured intrinsic title width, so artwork pulls inward for short titles while long titles get more copy width.
- `NOW PLAYING` sits outside the title/art grid; the album-art plate has zero compensating top margin and aligns exactly with the top of the title box.


## v8 — deterministic zoom/viewport fitting

- Hero stage now has a fixed viewport budget instead of a content-expandable minimum height.
- The title fitter evaluates the complete linked hero hierarchy for every candidate size, including artist, album, cover, facts, and controls.
- Preferred size derives from the smaller viewport dimension, making the composition visually stable across browser zoom.
- Resize/zoom fitting is reset and solved idempotently after a two-frame settle plus a final late-layout pass.
- Ellipsis remains a last resort after the entire hierarchy reaches its minimum scale.

- Desktop hero/page width is viewport-relative (`76vw`) rather than a fixed-pixel cap, so browser zoom does not physically narrow the composition.


## v9 hero fitter

- The hero now searches upward for the largest complete linked scale that fits the current viewport; it no longer starts from a guessed preferred title size.
- The title/art cluster is left-anchored to the same stage edge as the header, progress, facts, and controls.
- Copy-column width is derived from the actual title, artist, and album text, with only a small golden-ratio floor for very short titles.
- Browser zoom/resize solving remains stateless and deterministic; returning to a viewport should converge to the same geometry.


## v11 density normalization

- Reverted the v10 linked readability-floor change that distorted the hero hierarchy.
- Kept a CSS title fallback so unsolved/transient states cannot collapse to inherited text sizing.
- Added a 1.6x virtual design-density solver: browser zoom is normalized through the page's DPR change, so 100/140/160% and zoom round-trips target the same physical composition.
- Small system/control typography is enlarged through density mapping rather than by forcing higher hierarchy floors into the fit budget.


## v12 hero finishing pass

- Artwork is now anchored to the hero clamp's top-right edge on landscape/desktop and top-aligned with the title row.
- Artwork size follows the title on a golden-ratio (φ) scale, with geometric/hard caps so it stops growing and whitespace absorbs larger viewports.
- Portrait layouts stack artwork above the title instead of maintaining a side column.
- Hero/page width now has an explicit clamp-style maximum so ultrawide viewports create symmetric outer space instead of stretching the composition forever.
- Track facts are reordered by display relevance (primary genres → BPM/key → primary mood/energy → secondary taxonomy) and visually clamped; lower-priority tail data receives the ellipsis first.


## v13 hero finishing rules

- Landscape artwork is a true top-right clamp child: its right edge is the hero-stage right edge and its top edge is the title top edge.
- Artwork has a substantial floor, follows title size by φ above that floor, and clamps at a bounded maximum. Horizontal pressure shrinks typography before artwork.
- The title/art gutter is title-size / φ², itself clamped to a practical range.
- Die Grotesk display tracking is no longer aggressively negative; native kerning is preserved to prevent pairs such as `Ti` from colliding.
- Title, artist and album receive measured first-glyph optical inset compensation so their visible ink edges align, rather than merely their CSS boxes.
- Portrait retains the art-above-title composition.

## v14 radio interaction / AIR pass

- BPM and musical key are promoted to sharp-cornered 3270 metadata tags ahead of genre taxonomy; mood/energy descriptors are no longer shown in the now-playing facts line.
- `NOW PLAYING` uses the same monochrome tag treatment.
- The live status line now reads `LIVE` and includes the codec/bitrate the listener is actually using (`MP3` floor or `OPUS` when the browser is on the optional mount).
- Mute, Request, and History use Nerd Font glyphs. Request/History scroll directly to Dear DJ / AIR.
- `AIR LOG` is now `AIR`; track rows gain cover plates and use the same golden-ratio spacing ladder as the hero.
- The Dear DJ empty composer teaches the interaction with a one-time typed placeholder when the section first enters view.
- NEXT's unknown state cycles `selecting.` → `selecting..` → `selecting...` (static under reduced motion).


## v15 interaction / layout stability pass

- Request uses the Nerd Font Material Design `comment_plus` glyph (`U+F09E5`); History keeps the existing history glyph.
- Mute is grouped directly with the volume controls, with corrected muted/unmuted volume glyph polarity.
- Like uses fixed-metric Nerd Font outline/solid hearts so the LIKED state no longer changes control height or apparent scale.
- BPM, key and genre taxonomy are one inline clamped facts flow: badges lead the line and genre text can wrap beneath them instead of leaving a dead badge column.
- Title→artist and artist→album use the same golden-ratio spacing token.
- Dear DJ's animated instructional copy is a measured ghost layer rather than a textarea placeholder, so typing/wrapping grows the composer deterministically and cannot be clipped until a resize.
- Hero fitting keeps the established virtual-density model and adds an additional late idempotent settle pass so browser zoom/font/layout churn converges without needing a manual re-zoom.


## Experimental newpixie CRT overlay

This experiment replaces the sxntax skin's Ghostty-derived CRT overlay with a browser screen-space adaptation of Mattias Gustavsson's `newpixie-crt` shader (slang adaptation by hunterk). The original `.slang` source is retained beside the component for license/provenance. Because a DOM WebGL overlay cannot sample the already-rendered page framebuffer, the runtime port intentionally carries the shader's screen-space vignette, rolling scanlines, three-pixel shadow mask, noise, flicker, curved mask coordinates, and channel bias, while omitting source-dependent bleed/ghosting/frame-texture stages rather than rasterizing the page every frame.

### Experimental cheap source bleed

A second experimental layer restores part of newpixie's source-dependent ghosting without a DOM screenshot/readback loop. An SVG compositor filter receives the browser-rendered UI as `SourceGraphic`, isolates red/green/blue contributions, blurs and offsets them independently, then screen-blends the ghosts behind the crisp source. The filter is applied to the hero, Dear DJ, AIR, and Ratatui frame separately so the browser does not have to rasterize the entire scroll history as one filtered surface. Kawarp remains outside the bleed filter. The ghost offsets are static on purpose: this keeps the characteristic displaced phosphor smear while avoiding continuously invalidating the filtered layers.


## Newpixie bleed tuned experiment

This experimental branch keeps the v15 Newpixie source-dependent SVG bleed, but:

- removes Newpixie's vignette from the browser CRT overlay;
- restores the prior sxntax/Ghostty gold-v2 noise model;
- tempo-scales the CRT noise seed from the current track BPM (120 BPM = 1x, clamped to 0.6–1.65x);
- tempo-scales Kawarp `animationSpeed` from the current BPM (120 BPM = 1x, clamped to 0.65–1.55x);
- extends Kawarp artwork crossfades from the library's 1000 ms default to 3200 ms;
- enlarges FROM, AIR, NEXT, and AIR timestamps without changing the rest of the feed typography.


### Tuned soft-noise pass

This follow-up keeps the parts of the Newpixie experiment that tested best: scanlines, RGB bleed/ghosting, tiny flicker, and a subtle shadow mask, while returning to a fixed-speed sxntax/Ghostty gold-v2 noise pass at much lower strength. The previous vignette, BPM-reactive noise timing, and channel bias are removed.


## v18 final route

The hero route uses the final compact namespace: `/` links home and `radio/` is the current station mount, with no repeated `sxntax` suffix.


### v19 — native Home-scale composition

The public sxntax skin now makes the composition that previously appeared around 60% browser zoom the native 100% baseline. The page clamp is 790px to align with `sxntax.shop/home`; the former 1.6x virtual design-density compensation is removed. Per-track fitting is deliberately limited to the title, artist, and album/year typography (plus artwork geometry derived from the title). Route, station/status, facts, progress, and controls use fixed responsive shell sizes and therefore no longer jump when the song changes. DEAR DJ and AIR keep their larger reading-scale typography inside the narrower Home-aligned clamp. The route displays `/radio` (no trailing slash), and its segments use the same hard foreground/background hover highlight as the Home path navigator.

### Performance gate and transactional presentation

The SXNTAX skin now boots through a cheap shell before audio/effects are started. The frame paints immediately; content waits for the local Die Grotesk + 3270 faces and the first station snapshot/initial cover decode, so fallback typography and half-built cover/color states are not exposed. The tune-in surface is the renderer selector: `FULL/ECO` sits directly below the centered `TUNE IN` action, with the selected value using the same hard inversion as the site navigator.

`FULL` remains the default, but its renderer is a React.lazy boundary (`SxntaxFullEffects.tsx`). Kawarp and Newpixie WebGL are therefore not requested merely by visiting the page. A stored ECO preference is applied before paint by the existing lite bootstrap and can reach Tune In without instantiating the Full renderer. Tuning out destroys the running Full effect components as far as the browser permits; the downloaded code may remain in the browser cache.

**v49 recovery note.** The v48 fullscreen foreground WebGL material plane was removed. It composed an opaque screen/multiply surface above the complete radio UI; on bright polarity that could wash the resolved Signal toward white and make typography/frame contrast collapse. ECO therefore returns to the proven v47 static Field + background phosphor/noise architecture. Shop-parity optics are allowed only on bounded Signal elements, such as the outer Frame, not as a fullscreen polarity blend. Critical DiGrotesk/3270 URLs are revisioned in v49 so the recovery deployment forces a fresh font fetch while preserving the compact/fallback font contract.

ECO is Phosphoria Static, not a bare fallback. It keeps the content-emitted Field as a one-shot CSS composition derived from the cover's average and vibrant colours, applies the same foreground polarity decision as FULL, preserves frozen phosphor mask/noise, resting title/artist/album bloom, artwork/AIR optical framing, the luma clock halo, typography and Terminal hierarchy, and makes state changes atomically. It mounts no Kawarp or WebGL CRT and owns no continuously running decorative `requestAnimationFrame` loop. Once the page is stable, its branded material is static paint; track changes simply replace the Field and Signal.

Track presentation is transactional. A changed track's artwork is decoded before the visible metadata swap; FULL uses the phosphor decay/rewrite for title/artist/album/art while Kawarp carries the atmospheric transition, and ECO snaps atomically to the incoming Signal and newly derived static Field. Same-track enrichment updates in place without replaying the transition.


### v21 — smooth boot and ten-second station handoff

The tune gate now remains visible during the cheap shell boot instead of exposing an empty framed screen while fonts/feed/cover settle. Renderer release is queued until the transactional presentation snapshot is ready, so an early Full/Lite renderer-ready signal cannot reveal a blank scrollport. Full also waits briefly for both a CRT frame and compositor settlement before dissolving the gate.

The station's approximately ten-second audio crossfade is now the visual master window: Kawarp uses a 10,000 ms transition and starts from the incoming track immediately, while the foreground spends roughly 4 s decaying the outgoing phosphor and 6 s converging the incoming title/artist/album/art. The previous fast clip-path rewrite is removed in favor of continuous opacity/blur/RGB-persistence curves. Lite retains its fast text handoff, but its cover-derived ambience now crossfades over two solid full-screen layers using compositor-only opacity for a smooth low-power transition instead of stepped background-color repainting.

### v22 — atomic boot gate, softened pre-tune surface, phosphor reveal

The tune gate no longer exposes partially painted 3270 text or the selected performance highlight while the critical fonts are still blocking. A delayed, CSS-only signal sweep appears only on genuinely slow boots; once fonts are ready, the complete TUNE IN + FULL/LITE gate fades in atomically even if the station snapshot is still settling. The loaded hero is softened behind the gate with a short-lived 1.6px compositor blur and reduced opacity so the centered prompt never fights readable background text.

Lite now begins its existing static cover-colour compositor crossfade behind the gate whenever Lite is selected, so tuning in no longer starts from an abrupt black-to-tinted ramp. No new continuous renderer is introduced.

Full keeps the ten-second station handoff but restores stronger CRT character: the foreground moves through restrained RGB channel separation, phosphor bloom, blur, and opposite-channel convergence while artwork carries a matching chromatic persistence. The first Full tune-in uses a shorter version of the same phosphor language: the gate bleeds/fades out while the already-composited hero sharpens in over ~1.7 s instead of appearing as a hard cut.

### v23 — atomic boot, mode-inert gate, display-corruption handoff

The pre-tune shell now treats CSS and fonts as part of one chrome-readiness boundary. Before the skin stylesheet is confirmed by a computed-style probe, the content/gate are hidden with inline visibility while an inline black root and the terminal frame remain paintable; this prevents the raw unstyled player from flashing during slow CSS delivery. Until the clock face is actually ready, the frame draws a continuous top edge rather than reserving a blank clock gap.

The performance selector is now visually inert outside the selector itself: choosing FULL/LITE at the gate does not preview ambient color or renderer effects. Lite only mounts after Tune In, snaps its static cover wash/metadata immediately, and disables retained-wheel/smooth section scrolling. Full remains lazy-loaded after Tune In; its Kawarp and ambient base now begin from black and reveal over the same 10-second station handoff instead of already being colored behind the modal.

Full song changes now add a short-lived SVG displacement field, horizontal raster/dropout texture, RGB persistence and phosphor bloom to the established 4s decay + 6s rewrite. Non-track UI anchors (header/NOW PLAYING/progress/facts/controls) use a FLIP-style ~2.3s glide at the metadata crossover so title-fit recalculation moves the rest of the hero progressively instead of jumping. The Tune In → Full reveal uses the same display-lock/corruption vocabulary, while Lite deliberately remains a snap path.


### v24 quality/eco + CRT transition pass

- public performance labels are now QUALITY/ECO (internal full/lite semantics remain unchanged);
- the boot indicator follows Ratatui LineGauge semantics with a high-contrast filled/unfilled rail tied to actual boot readiness;
- the frame itself is no longer passed through the RGB bleed filter, eliminating the doubled-border artifact while keeping a subtle chromatic clock;
- Tune In background softening is stronger but remains a transient CSS blur rather than backdrop-filter;
- QUALITY CRT rendering now draws on every requestAnimationFrame instead of an explicit 30 fps throttle;
- track handoff intensity follows an accelerate -> corruption climax -> decelerate envelope with stronger phosphor channel separation, raster dropout, displacement and cover persistence.

### v25 boot + transition envelope

- Startup now uses an inline critical black/frame veil with a simple Ratatui-style line gauge, covering all unstyled/partial-font states until CSS, fonts, first feed, and initial media are ready.
- Track geometry is solved synchronously once before the first paint after a song swap, then late-settle passes remain for Firefox zoom/font churn.
- The track cluster itself participates in FLIP (translation + scale), not only the surrounding fixed anchors, reducing the visible title/artist/album reflow jump.
- QUALITY corruption now uses a sharply concentrated, log-like envelope: long clean lead-in, fast acceleration into a stronger RGB/raster/displacement climax, then a quick initial recovery followed by a long clean settle.

### v30 — two-stage Tune In boot + monochrome handoff cleanup

Startup now has separate UI and player readiness boundaries. CSS + the two local SXNTAX faces are enough to reveal the complete `TUNE IN` / `QUALITY/ECO` gate; feed and first-cover preparation continue behind that stable black gate and only control when the finished hero may appear/release. The critical boot frame remains a complete top line, its small line gauge is delayed so cached visits do not flash a loader, and the normal Radio frame is held until the boot veil is gone to avoid doubled borders.

Track and Tune In transition effects no longer add transition-specific scanline/raster masks or colored RGB corruption. QUALITY playback keeps its ordinary Newpixie scanlines/RGB bleed, but animated handoffs themselves use monochrome shadows/ghosts plus blur, brightness, displacement, and bloom. ECO behavior is unchanged.

### v31 — phosphor bloom bridge + preflight corridor

Track handoffs now preflight the incoming title/art geometry in an invisible measurement stage. The live hero reserves the larger outgoing/incoming track corridor before the metadata swap, so the broadcast header, playback telemetry, track facts, and actions can move into safe positions before a long incoming title appears. The live track itself is no longer FLIP-scaled.

The QUALITY handoff no longer uses the signal-corruption/turbulence filters or transition raster masks. During the handoff the track presentation temporarily leaves the normal RGB bleed surface and uses only monochrome persistence, defocus, bloom, horizontal phosphor smear, and grayscale artwork persistence. Stable playback keeps the normal Newpixie RGB bleed and gains a restrained resting title/artist phosphor bloom.

### v32 — transition engine + atomic boot shell

- Boot is now a genuinely separate critical render path. Before the SXNTAX CSS contract and both local fonts are ready, React renders only the black surface, complete frame, and a delayed high-contrast line gauge; the normal Radio hero is not mounted underneath. Once UI-ready, `TUNE IN` / `QUALITY/ECO` appears atomically. The hero itself is mounted only after the first station/media presentation is coherent.
- QUALITY track handoffs use one 10-second master clock with a narrow bell-shaped intensity envelope (`sin(pi*p)^N`). The metadata string swaps at peak intensity instead of using independent decay/rewrite keyframes.
- Incoming geometry is solved in the hidden full-hero probe. Broadcast header, playback telemetry/facts, and controls animate toward their incoming final coordinates during the quiet lead-in and their temporary transforms are cancelled in a layout effect when the real incoming layout commits, preventing a crossover jump without cloning the hero.
- The whole hero leaves normal RGB `sx-newpixie-bleed` during a handoff. Transition-specific color separation is therefore monochrome luma misconvergence only.
- The transition vocabulary is phosphor bloom + halation + persistence/afterimages + horizontal smear + monochrome convergence error. The title carries the strongest effect, artist less, album/year least; artwork progressively desaturates/defocuses instead of receiving colored ghosts.
- Newpixie scanlines and the shadow mask remain part of stable QUALITY playback, but are progressively neutralized by the handoff intensity so the bloom climax cannot turn the raster into bright horizontal streaks. Flicker/noise rise only slightly; shader curvature breathes microscopically and never changes CSS geometry.
- The former turbulence/displacement `sx-signal-corrupt*` filters are removed. Tune In's QUALITY surface reveal is monochrome focus/convergence acquisition rather than signal-corruption displacement.
- Temporary tuning query parameters are available for visual calibration without architectural edits: `sxPeak`, `sxBloom`, `sxHalo`, `sxThreshold`, `sxPersist`, `sxAfter`, `sxSmear`, `sxConverge`, `sxFlicker`, `sxNoise`, `sxCurve`, `sxScan`, and `sxMask`. Values are bounded in `readTransitionTuning()`.

## v33 — hard-isolated monochrome handoff

This pass removes the two transition artifacts that survived earlier tuning at their actual sources. During a QUALITY track handoff, hero sections no longer carry the RGB `sx-newpixie-bleed` class, the frame clock's RGB misconvergence is suppressed, and Newpixie's scanline/shadow-mask factors are forced neutral for the entire handoff rather than only near the peak. Noise/flicker and the rest of the stable CRT identity remain available outside the handoff.

Layout prepositioning no longer uses section-level FLIP transforms. The hidden incoming probe is used only to measure the future track height; before the visual ramp the live track corridor animates to `max(outgoing, incoming)`, moving broadcast status and lower telemetry clear in ordinary grid flow. The corridor contracts to the incoming height only after the ten-second handoff finishes.

The visual bridge now uses three coupled monochrome envelopes: broad phosphor persistence, a stronger bloom/halation/defocus envelope, and a narrow convergence/flicker climax. Default bloom, afterimage and smear strengths were raised so the title can actually lose glyph boundaries at the midpoint before the incoming string resolves. The URL tuning parameters from v32 remain available for calibration.

## v35 — root artifact removal

This pass removes the artifact generators instead of trying to hide them only during a handoff.

- Natural cover/Kawarp colour remains fully enabled; the v34 handoff grayscale/desaturation override is reverted.
- `NewpixieBleedFilter` is removed from the Full renderer. The runtime no longer extracts red/green/blue channels, offsets them, or screen-blends them back into the UI.
- The frame clock and ECO phosphor treatment use neutral `currentColor` halos instead of explicit red/blue shadows.
- The WebGL horizontal scanline oscillator and its `sxScan`/`scanSuppression` plumbing are removed. Full CRT character now comes from the vertical shadow mask, noise, flicker and curvature.
- ECO's horizontal repeating-linear-gradient scanline layer is removed; the faint vertical mask/noise texture remains.
- The v34 old-identity -> phosphor-mass -> new-identity bridge, safe corridor geometry, midpoint swap and ten-second pacing are unchanged.

The retained `newpixie-crt.slang` file still contains upstream scanline code for provenance only; it is not imported or executed by the browser renderer.

### v43 startup fast path

SXNTAX is the only supported public player skin. Startup no longer hydrates skin selection or preloads unrelated theme fonts. Die Grotesk and the source-generated SXNTAX 3270 Nerd Font subset are the only critical local faces; the latter preserves the 3270 system-text core plus only source-referenced Nerd glyphs instead of shipping the 2.75 MB upstream font to listeners. Full Kawarp/Newpixie remains interaction-gated, AIR/Dear DJ use rendering containment, AIR covers are lazy, session/AIR polling is kept off the critical hero response, and service-worker/beacon work is deferred to idle time. Initial artwork is prefetched but no longer blocks the player reveal.

## P15 correction: audio-responsive Kawarp

FULL mode retains Kawarp as the background base and the Newpixie CRT overlay.
`PhosphoriaAudioKawarp.tsx` uses the existing shared `useAnalyser` audio graph to drive Kawarp's native `warpIntensity`, `animationSpeed`, `saturation` and `scale` props from bass/mid/high energy and a smoothed relative onset envelope. No extra canvas, orbiting artwork layers, second WebGL context, additional stream or independent audio routing is used. The existing ten-second Kawarp image crossfade and Newpixie/Phosphoria treatment remain in charge. React prop updates are bounded, but Kawarp's internal WebGL requestAnimationFrame is not frame-rate capped. ECO remains a strictly static field.

## P16 — Phosphoria material response (Kawarp-native field, not orbital artwork)

P16 replaces P15's orbital canvas and extends P15R's scalar modulation with a
**damped, spatial material model** driven by the shared station audio analyser.
The physical metaphor is consistent across music: sound supplies forces, the
fluid carries deformation, and the phosphor retains its own established light
character. It is a visually motivated oscillator/pressure-wave approximation,
**not** a computational fluid solver, BPM estimator, or vocal recognizer.

- **Pressure**: smoothed bass provides sustained broad UV displacement; release
  takes longer than attack.
- **Impulse**: positive 12-band logarithmic spectral flux exceeding an adaptive
  baseline launches up to four moving radial waves. A refractory interval
  prevents one hit from becoming an uncontrolled cluster of repeated events.
- **Turbulence**: high-band changes produce fine domain-warp variation instead
  of making the entire canvas spin or pulse.
- **Inertia, viscosity, elasticity**: a bounded damped oscillator retains
  velocity through sound gaps and returns toward equilibrium gradually.
- **Persistence**: decaying excitation subtly influences color saturation; it
  does not pretend to recreate phosphor-frame accumulation (Newpixie and the
  existing Phosphoria handoff treatment own the CRT appearance).
- **Diffusion**: track-handoff intensity enters a slow material envelope while
  Kawarp's original crossfade independently blends old/new artwork colors.
- **Silence, unavailable Web Audio, reduced motion**: no synthetic impulses,
  with natural settling; reduced motion neutralizes custom shader uniforms.

`phosphoriaMaterial.ts` owns pure semantics, `kawarpMaterialBridge.ts` adds
uniforms and the localized pressure-wave term to the existing `@kawarp/core`
1.2.2 **domain warp shader on the same WebGL context**, and
`PhosphoriaAudioKawarp.tsx` supplies measured FFT bins to that field. No second
WebGL canvas or replacement artwork renderer is created; Kawarp retains its
own native requestAnimationFrame, CSS-resolution output, blur pass and source
crossfade. React option commits remain coalesced separately from render FPS.

The bridge is deliberately tied to the domain shader's explicit source
signature. If the signature changes, the original shader remains unchanged
(`data-material-bridge="shader-mismatch"`). If the shader fails compilation,
it is retried with the pristine source. **Do not silently upgrade
`@kawarp/core` without running the shader/browser acceptance matrix.**

Browser proof must show `data-material-bridge="active"` and measured pressure,
impulses and coherent settling with real audio, plus ordinary playback and
public decoded non-silent MP3. `active` alone does not prove a visible response.
Test performance on RX 5700 XT and a modest GPU, desktop/portrait FULL, ECO,
reduced motion, silence, continuous bass, sharp hits, 10-second handoff and
browser stop/start. No acceptance is claimed from author-side pure tests alone.

## P17 — Material response reliability and diagnostic hardening

The P16 material model remains the visual contract. P17 **does not add a second
compositor** or alter Kawarp's rendering resolution and frame schedule. It
addresses several production-relevant edge cases before the first deployment:

- **Impulse hysteresis:** a rising spectral novelty signal triggers once and
  must settle before it can trigger again. The refractory interval is a second
  defense, not a replacement for transient detection. Sustained elevated flux
  can no longer generate a false periodic beat.
- **Material controls:** wave propagation speed is carried from the material
  control set into the shader uniforms; the visible wave count is bounded to
  the shader's four slots even if configuration requests more.
- **Hidden-tab recovery:** dormant impulses and pressure relax without a costly
  background animation loop; FFT band comparison is reset on resume to prevent
  a spurious impact from the changed music position. Reduced-motion toggling
  also relaxes the field before resuming normal motion.
- **WebGL hygiene:** the adapter restores only the canvas/context methods it
  personally replaced and suppresses late diagnostic callbacks after teardown.
  An unpatchable canvas or mismatched shader leaves the original Kawarp alone.
- **Evidence:** `data-material-bridge="active"` now requires an actual draw by
  the instrumented warp program with all three material uniform locations,
  not just a successful shader link. `data-material-energy`, `data-material-flux`
  and `data-material-onsets` aid controlled audio verification without exposing
  media content. `uniform-mismatch` is a separate fail-closed state.

These changes have unit and mocked-WebGL coverage; the actual 1.2.2 shader
still requires local real-browser/GPU execution and non-silent audio proof.
The phenomenological fluid metaphor is unchanged; source audio never identifies
an instrument or BPM with certainty, and ECO remains unchanged.


## P18 — Audio-responsive original Kawarp, without wave emitters (supersedes P16/P17 visuals)

Following listening/visual feedback, the P16/P17 wavefront design is retired.
Those prior sections document history, **not** the expected live P18 appearance.
The blurred artwork should remain recognizably multicolored and retain Kawarp's
natural noise-domain deformation, **not** zoom/expand into a homogeneous smear.

- **Deformation:** sustained energy (weighted toward bass) and brief detected
  onsets increase the *amplitude of Kawarp's original warp field*. There are
  no extra spatial wavefronts, artificial beat ripples or orbiting artwork.
- **Optical response:** the existing output pass applies bounded post-Kawarp
  luminance, contrast and saturation changes. They can be tuned independently
  from deformation and leave the source hue/artwork crossfade untouched.
- **Musical dynamics:** 12 log-frequency bands, a slowly adapting loudness
  reference, rising-edge spectral-flux onset hysteresis, and separate optical
  attack/release times. Sustained loudness is not a stream of percussive events.
- **Track change:** the handoff influences the grade smoothly but does not
  invent an onset; Kawarp still owns the actual artwork color transition.
- **Still image contract:** image scale remains fixed at `1`; neither raw
  canvas resolution nor Kawarp's render cadence is capped by this module.
  No second canvas or audio graph is created.
- **Unsupported audio / ECO / reduced motion:** normal Kawarp ambient visuals,
  static ECO, or zero shader response respectively; playback ownership stays
  with the station. Reduced motion also requests zero Kawarp animation speed.

`kawarpMaterialBridge.ts` recognizes **two** signature-locked `@kawarp/core`
1.2.2 shaders: DOMAIN_WARP and OUTPUT. Each uses a `u_ph_response` vector
`[warpGain, luminanceOffset, contrastMultiplier, saturationMultiplier]`.
Only `active` after both passes have executed with the uniforms; `partial`
indicates only one is active. A failed injection recompiles the original
upstream shader. Do not upgrade Kawarp without re-verifying both signatures.

Local acceptance must compare genuine music dynamics with four isolated
fixture states (silence, steady music, onset, handoff), confirm visible but
controlled deformation/color changes, normal blur/artwork palette, full
Chromium/Firefox WebGL behavior, no wave pattern, and *actual decoded audio*
after deployment. Source tests/mock WebGL cannot establish visual quality.
