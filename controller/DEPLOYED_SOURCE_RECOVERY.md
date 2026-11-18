# Deployed controller source recovery

This recovery layer records source observed in local controller image
`sha256:652ae4eb0906d83fc0bcc4d32d2a3e14acd1b55e4050b4e8d8808b175795e4cb`,
over Gate 2 commit `a887215fc167d3c9cb4236da38b8a89630d4e588`. It is a
source snapshot for review, not evidence that a rebuilt image is identical.

The image's complete `/app/src` inventory contains 418 regular files. Against
the parent commit, 380 matched; 28 differed and 10 existed only in the image.
All 38 differences are recovered explicitly; the resulting 418 source paths
match the image byte-for-byte. The private picker-audit module and integration
were already in the parent and remain intact.

Categories of the recovered source differences:

- Async vector/search: `music/library-db/{knn-query.mjs,vector-search.ts,
  vector-worker.mjs,vectors.ts,tracks.ts}`, `music/library.ts`,
  `music/picker.ts`, `music/playlist-gen.ts`, and six picker search tools.
- Async library statistics: `music/library-db/{stats.ts,stats-query.mjs,
  stats-worker.mjs}`; lyrics presentation: `music/lyrics-display.ts`.
- Existing queue, listener/idle, air-history, likes, stream-control and tagger
  customizations: six changed `broadcast/` files plus `air-history.ts` and
  `playback-clock.ts`; related `routes/{dj,library,likes,public}.ts`.
- Context, show/public shapes, Subsonic, analyzer and semantic model handling:
  `context.ts`, `schemas/show.ts`, `music/{subsonic.ts,analyze.ts,
  semantic-retry.ts,semantic/classify.ts,semantic/one-call.ts,
  tag-library/semantic.ts}`.

Earlier Git commit `627811c5a0459c6cde6c85ae23ce3247c28d85d8` independently
matches 396 of the 418 image source files. Its different parent lacks this
branch's ChatGPT-plan and Gate 2 changes; it is supporting evidence, not a
substitute parent. Of the 38 recovered paths, 28 also matched the primary
checkout at inspection; seven differed and three were absent there.

Eight deployed source tests/runners and the deployed `state-bootstrap.test.ts`
were also recovered. Python bytecode under the image's scripts directory was
not copied. Seven Git-only scripts are retained as repository tests; they are
not asserted to exist in the image.

Image `/app/package.json` and `/app/package-lock.json` match this parent by
SHA-256; runtime Node is v22.23.2. The image omits `/app/tsconfig.json` and a
Dockerfile, and its installed dependency/build environment is not reproduced
by these hashes. Image history records copied source/scripts and
`npm ci --omit=dev`, plus earlier customized layers, but does not establish a
byte-reproducible build recipe or the provenance of every build input. Retain
the image digest as runtime authority; do not claim binary parity.
