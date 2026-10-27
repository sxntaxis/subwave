import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createHandoffLease,
  isTrackHandoffActive,
  settledTrackPresentation,
  shouldResetTrackHandoffStyles,
  type TrackPresentationPhase,
} from '../components/skins/sxntax/trackPresentationState';

type Identity = { id: string; title: string; artist: string; cover: string };
type Handoff = { outgoing: Identity; incoming: Identity };

function renderIdentity({
  phase,
  presentation,
  live,
}: {
  phase: TrackPresentationPhase;
  presentation: Handoff | null;
  live: Identity;
}): string {
  const active = isTrackHandoffActive(phase, presentation);
  return renderToStaticMarkup(
    createElement('section', { className: active ? 'trackHandoff' : 'stable' },
      createElement('div', {
        className: 'nowCopy',
        'data-live-identity': live.id,
        hidden: active,
      }, `${live.title} — ${live.artist}`),
      active && presentation
        ? createElement('div', { className: 'identityBridge', 'aria-hidden': true },
          createElement('span', { 'data-bridge-identity': presentation.outgoing.id }, `${presentation.outgoing.title} — ${presentation.outgoing.artist}`),
          createElement('span', { 'data-bridge-identity': presentation.incoming.id }, `${presentation.incoming.title} — ${presentation.incoming.artist}`),
        )
        : null,
      active && presentation
        ? createElement('figure', { className: 'coverHandoff' },
          createElement('img', { 'data-cover-identity': presentation.outgoing.id, src: presentation.outgoing.cover }),
          createElement('img', { 'data-cover-identity': presentation.incoming.id, src: presentation.incoming.cover }),
        )
        : createElement('figure', { 'data-cover-identity': live.id, 'data-cover-src': live.cover }),
    ),
  );
}

const jenny: Identity = {
  id: 'jenny', title: 'Jenny of Oldstones', artist: 'Florence + the Machine', cover: '/cover/jenny',
};
const portrait: Identity = {
  id: 'portrait', title: 'Unrelated interstitial', artist: 'Another state', cover: '/cover/portrait',
};
const next: Identity = {
  id: 'next', title: 'Next track', artist: 'Next artist', cover: '/cover/next',
};

test('handoff teardown commits the live identity before resetting bridge opacity and cover variables', () => {
  const active = { phase: 'rewrite' as const, presentation: { outgoing: portrait, incoming: jenny } };
  assert.equal(isTrackHandoffActive(active.phase, active.presentation), true);
  assert.equal(shouldResetTrackHandoffStyles(active.phase, active.presentation), false);
  const during = renderIdentity({ ...active, live: jenny });
  assert.match(during, /class="trackHandoff"/);
  assert.match(during, /data-bridge-identity="portrait"/);
  assert.match(during, /data-bridge-identity="jenny"/);
  assert.match(during, /data-cover-identity="portrait"/);
  assert.match(during, /data-cover-identity="jenny"/);

  // This is the committed state at handback; CSS reset is permitted only after
  // this render removes the class that hides `.nowCopy`.
  const settled = settledTrackPresentation<Handoff>();
  assert.equal(isTrackHandoffActive(settled.phase, settled.presentation), false);
  assert.equal(shouldResetTrackHandoffStyles(settled.phase, settled.presentation), true);
  assert.equal(renderIdentity({ ...settled, live: jenny }),
    '<section class="stable"><div class="nowCopy" data-live-identity="jenny">Jenny of Oldstones — Florence + the Machine</div><figure data-cover-identity="jenny" data-cover-src="/cover/jenny"></figure></section>');

  // A cleanup commit may clear the snapshot before phase state is refreshed;
  // without the snapshot there must still be a coherent live presentation.
  const interrupted = { phase: 'rewrite' as const, presentation: null };
  assert.equal(isTrackHandoffActive(interrupted.phase, interrupted.presentation), false);
  assert.equal(shouldResetTrackHandoffStyles(interrupted.phase, interrupted.presentation), true);
  assert.equal(shouldResetTrackHandoffStyles(interrupted.phase, interrupted.presentation), true);
  assert.match(renderIdentity({ ...interrupted, live: jenny }), /data-cover-identity="jenny"/);
  assert.match(renderIdentity({ ...interrupted, live: jenny }), /Jenny of Oldstones — Florence \+ the Machine/);
});

test('rapid A→B cancellation and a late cover decode cannot replace the newer B→C handoff', async () => {
  const oldLease = createHandoffLease();
  let resolveOldDecode!: () => void;
  const oldCoverDecode = new Promise<void>(resolve => { resolveOldDecode = resolve; });
  const staleCompletion = oldCoverDecode.then(() => {
    if (!oldLease.isCurrent()) return null;
    return { phase: 'rewrite' as const, presentation: { outgoing: jenny, incoming: portrait } };
  });

  oldLease.cancel();
  const interrupted = settledTrackPresentation<Handoff>();
  const newLease = createHandoffLease();
  let current: { phase: TrackPresentationPhase; presentation: Handoff | null } = {
    phase: 'decay' as const,
    presentation: { outgoing: jenny, incoming: next },
  };
  resolveOldDecode();
  const stale = await staleCompletion;
  if (stale && newLease.isCurrent()) current = stale;

  assert.equal(oldLease.isCurrent(), false);
  assert.equal(isTrackHandoffActive(interrupted.phase, interrupted.presentation), false);
  assert.equal(isTrackHandoffActive(current.phase, current.presentation), true);
  const html = renderIdentity({ ...current, live: jenny });
  assert.match(html, /data-bridge-identity="jenny"/);
  assert.match(html, /data-bridge-identity="next"/);
  assert.doesNotMatch(html, /data-bridge-identity="portrait"/);
  assert.match(html, /data-cover-identity="jenny"/);
  assert.match(html, /data-cover-identity="next"/);
  assert.doesNotMatch(html, /data-cover-identity="portrait"/);
});
