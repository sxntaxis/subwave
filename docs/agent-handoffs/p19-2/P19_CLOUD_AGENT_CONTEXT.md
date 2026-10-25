# SUB/WAVE P19.2 deployed source context

This bundle is a point-in-time source snapshot of the deployed, reconciled P19.2 web plus controller state. Snapshot commit identity is synthetic; the authored P19.2 commit was `5b6e4b666228f77935a2f32da73c63c8503d028c`.

## Provenance and deployed runtime

- P19.2 was integrated over P17/P18/P19/P19.1 and the latest lyric-layout polish + mixed-timing fix.
- Deployed web image at packaging: `subwave-web:p19-2-5b6e4b6`, image `sha256:45bb240e1ce8655492036ebd5f680711eb6839c94a06d80313b7fe46031dd243`.
- Controller, broadcast, Navidrome, queue and backfill were not changed by the P19.2 web-only release.
- Controller and broadcast require the existing Compose network override that attaches both to external `stella_internal` for Navidrome access. Do not remove it.
- One-step rollback on the host: `bash /mnt/Tokyo/Lab/.tmp/opencode/SUBWAVE_P19_2/rollback.sh`.

## Included integration state

- P19.2 source-patch changes are represented in the snapshot; source manifest adjacent to the archive lists exact file hashes.
- Newpixie highlight CSS parsing fix is present: `::highlight(sxntax-lyric-hover)` styling is injected from `LyricsPerspective.tsx` in a component-lifetime stylesheet, not in the CSS module.
- P17/P19.2 artwork polarity helper, P19.1 normalized material, WebGL/Kawarp bridge, two-polarity CRT, diagnostics/tests, P18/P19 audio response and P19.2 incoming-artwork crossfade are included.
- Layout polish and mixed-timing lyrics fixes are retained: restored telemetry/facts, compact cover/title identity, centered text, edge fade, text-range hover, native YouLyPlus mixed per-line word/line cues, duet/backing/translation/romanization/offset.
- P15 orbital canvas is not included or instantiated. Kawarp remains the one background artwork renderer, with Newpixie CRT as its existing overlay.

## Validation evidence (historical at package time)

- P19.2 source/typecheck/build and 128 web tests passed; transition files contain both dark→bright and bright→dark runs sampled at 0/2/4/6/8/10 s on RX 5700 XT WebGL.
- The installed host was verified with non-silent public MP3, current-track lyrics API and controller/broadcast Navidrome networking.
- Browser QA also reproduced real zoom and retained the layout-polish fixes. See P19.2 final report in the host campaign directory.

## Omitted intentionally

- No `node_modules`, `.next`, runtime state, environment/credential files, private benchmark IDs/paths, audio captures, Navidrome DB, proprietary artwork or owner-supplied Di Grotesk font binaries are included. The source references `/fonts/DiGrotesk-*.woff2`; the owner must provide its licensed archive locally.
- This is a source snapshot, not a deploy image or Git ancestry-preserving PR branch. Base future changes on an explicitly selected live repository state and inspect current service/image identity before deployment.
