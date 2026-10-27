import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lyricsOpeningScrollTop } from '../components/skins/sxntax/lyrics/lyricsFrame.ts';

test('opening lyrics keeps the whole fixed-height hero in the player viewport', () => {
  assert.equal(lyricsOpeningScrollTop({
    outerTop: 22, outerHeight: 672, outerScrollTop: 0,
    heroTop: 22, heroHeight: 672,
  }), 0);
});

test('opening lyrics never scrolls the outer player to chase a lyric line', () => {
  assert.equal(lyricsOpeningScrollTop({
    outerTop: 22, outerHeight: 672, outerScrollTop: 640,
    heroTop: -618, heroHeight: 672,
  }), 0);
});

test('a partially obscured fixed hero is aligned by its own top edge', () => {
  assert.equal(lyricsOpeningScrollTop({
    outerTop: 22, outerHeight: 672, outerScrollTop: 200,
    heroTop: -18, heroHeight: 672,
  }), 152);
});

test('invalid measurements leave the current outer scroll position alone', () => {
  assert.equal(lyricsOpeningScrollTop({
    outerTop: 22, outerHeight: 0, outerScrollTop: 125,
    heroTop: 0, heroHeight: 900,
  }), 125);
});
