import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canShowLyrics, shouldReturnToArtwork, shouldShowRequestedLyrics } from '../components/skins/sxntax/lyrics/lyricsMode.ts';
import type { LyricDocument } from '../components/skins/sxntax/lyrics/lyricsModel';

const document: LyricDocument = {
  id: 'synthetic', timing: 'plain', lines: [{ id: '0', text: 'Synthetic fixture' }],
};

test('lyrics control is disabled for missing, failed, and unresolved Navidrome documents', () => {
  assert.equal(canShowLyrics('loading', null, false), false);
  assert.equal(canShowLyrics('missing', null, false), false);
  assert.equal(canShowLyrics('error', null, false), false);
  assert.equal(canShowLyrics('available', null, false), false);
  assert.equal(canShowLyrics('available', document, false), true);
});

test('synthetic dev-only preview remains available when Navidrome has no document', () => {
  assert.equal(canShowLyrics('missing', null, true), true);
});

test('an airing change keeps lyrics mode while availability is loading', () => {
  assert.equal(shouldReturnToArtwork(true, false, 'next-track', false, 'loading'), false);
  assert.equal(shouldReturnToArtwork(true, false, 'next-track', false, 'available'), false);
});

test('missing or failed lyrics returns to default art; idle state never triggers a close', () => {
  assert.equal(shouldReturnToArtwork(true, false, 'next-track', false, 'missing'), true);
  assert.equal(shouldReturnToArtwork(true, false, 'next-track', false, 'error'), true);
  assert.equal(shouldReturnToArtwork(true, false, null, false, 'loading'), true);
  assert.equal(shouldReturnToArtwork(true, false, 'current', true, 'available'), true);
  assert.equal(shouldReturnToArtwork(false, false, 'current', false, 'missing'), false);
  assert.equal(shouldReturnToArtwork(true, true, 'current', false, 'missing'), false);
});

test('lyrics intent survives missing and loading recordings, then auto-restores for the next timed song', () => {
  let wanted = true; // listener clicked LYRICS on track A
  assert.equal(shouldShowRequestedLyrics(wanted, 'available', document, false, false), true);
  // B has no lyrics; show normal artwork but DO NOT clear wanted.
  assert.equal(shouldShowRequestedLyrics(wanted, 'loading', null, false, false), false);
  assert.equal(shouldShowRequestedLyrics(wanted, 'missing', null, false, false), false);
  assert.equal(wanted, true);
  // C does have lyrics; no second user action necessary.
  assert.equal(shouldShowRequestedLyrics(wanted, 'available', document, false, false), true);
  // Only an explicit click on the control clears intent.
  wanted = false;
  assert.equal(shouldShowRequestedLyrics(wanted, 'available', document, false, false), false);
});

test('offline stops lyric presentation without erasing intent and previews remain usable', () => {
  assert.equal(shouldShowRequestedLyrics(true, 'available', document, false, true), false);
  assert.equal(shouldShowRequestedLyrics(true, 'available', document, false, false), true);
  assert.equal(shouldShowRequestedLyrics(true, 'missing', null, true, true), true);
  assert.equal(shouldShowRequestedLyrics(false, 'missing', null, true, false), false);
  assert.equal(shouldShowRequestedLyrics(true, 'error', null, false, false), false);
});
