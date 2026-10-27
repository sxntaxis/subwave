# Phosphoria baseline — 2026-10-27

Owner requested this checkpoint after accepting the current lyric/native-clock
state. This is a recovery baseline, not a claim that every UI path is defect-free.

- Branch: `checkpoint/phosphoria-2026-10-27`
- Tag: `phosphoria-baseline-2026-10-27`
- Scope: the exact deployed web release source and its Docker/font build inputs.
  Controller/broadcast source on this branch is the repository base, not a claim
  of exact correspondence to the locally modified running backend images.
- Source release: `SUBWAVE_YOULY_NATIVE_RECOVERY/source` after the coarse mixer
  clock substitution was reverted.
- Running web: `subwave-web:youly-native-stable-clock`
- Exact web image ID:
  `sha256:a36861941e3a3ebfa786ec511c20217fd1bb745088cbadc5f17c3e4e147556e9`
- Checkpoint image tag: `subwave-web:phosphoria-baseline-2026-10-27`
- Running controller image ID:
  `sha256:36eea27e6c22d9f4ec6b5716da0c2f1c0ca73070f1897ad7c5cf9a64666d0c51`
- Running broadcast image ID:
  `sha256:1f1c4974ff2e4a044614f6107a7e9f4c9b7b608a5a2b82ceb31a1062668ec256`

## Accepted behavior to preserve

Current responsive typography/artwork relationship, native YouLyPlus scroll and
highlight machinery, source cues/duets/translation/romanization/FOLLOW, inactive
blur (.035em near/.07em far), hidden native menus, song-handoff choreography,
foreground reconciliation, media-stall handling and secure pinned dependencies.
No arbitrary presentation lead or coarse mixer-clock substitution is applied.

## Newly reported issue, saved before correction

Owner screenshots `Screenshot From 2026-10-27 03-04-44.png` and
`Screenshot From 2026-10-27 01-41-31.png` show the normal identity overlapping
progress/controls after returning from Lyrics and a song change. This checkpoint
intentionally captures the pre-correction baseline. Fix that on a separate branch
without moving or replacing this tag. No automated visual testing is authorized.

## Fast web-only fallback on the current installation

If absent locally, first load the archived image:

```sh
docker load -i /home/sxntax/Downloads/SUBWAVE_PHOSPHORIA_BASELINE_20261027_WEB.docker.tar.gz
```

Then, from the deployment repository with its normal existing Compose overlays,
append this directory's `web.override.yml` LAST and use:

```sh
docker compose -p subwave -f docker-compose.yml \
  -f docs/checkpoints/phosphoria-2026-10-27/station-images.yml \
  -f docs/checkpoints/phosphoria-2026-10-27/web.override.yml \
  up -d --no-deps --no-build --pull never web
```

`station-images.yml` records the currently deployed backend tags/networks; the
command targets web only. Keep the installation's existing root environment and
state mounts. Never replace `state/`, restart backend services, or run whole-stack
`up --build` just to restore this web checkpoint.

For source recovery:

```sh
git clone --branch phosphoria-baseline-2026-10-27 https://github.com/sxntaxis/subwave.git subwave-phosphoria-baseline
```

Or clone the complete `.bundle` in Downloads. Rebuilding uses the committed
`web/Dockerfile`, lockfile, fonts and `tools/build-sxntax-nerdfont.py`; the saved
Docker image is the exact runnable artifact and avoids dependency/base-tag drift.

## Verification and boundaries

The accepted web image passed its production compilation and focused nonvisual
checks during deployment. No browser automation, screenshots or visual testing
was performed for checkpointing. No secrets, environment files, runtime state,
database or generated dependencies are included. The main dirty checkout was
left untouched; checkpoint source was assembled in a separate Git worktree.
