import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  blendArtworkRgb, artworkFadeColor, artworkFadeProgress,
  artworkLuminance, nextArtworkPolarity, parseArtworkRgb,
  type ArtworkPolarityFade,
} from '../components/skins/sxntax/phosphoriaArtworkPolarity.ts';

const dark = [4, 4, 4] as const;
const bright = [245, 245, 245] as const;
const fade: ArtworkPolarityFade = { source: 'new-art', from: dark, startedAt: 1000, durationMs: 10000 };

test('source-bound RGB samples reject malformed values and do not assume a pending cover is black', () => {
  assert.deepEqual(parseArtworkRgb('rgb(240, 221, 200)'), [240, 221, 200]);
  assert.equal(parseArtworkRgb('url(paint)'), null);
  assert.equal(parseArtworkRgb(null), null);
  assert.equal(parseArtworkRgb('rgb(999, 2, 1)'), null);
  assert.deepEqual(artworkFadeColor(fade, null, 6500), dark);
});

test('artwork polarity changes DURING Kawarp 10s crossfade, not at the title swap', () => {
  const before = artworkFadeColor(fade, bright, 1000);
  const halfway = artworkFadeColor(fade, bright, 6000);
  const finished = artworkFadeColor(fade, bright, 11000);
  assert.deepEqual(before, dark);
  assert.ok(artworkLuminance(halfway) > artworkLuminance(dark));
  assert.ok(artworkLuminance(halfway) < artworkLuminance(bright));
  assert.deepEqual(finished, bright);
  // Evaluate ahead of the 3.2s foreground transition; it should begin well
  // before 10s, yet meet the background near the optical crossover.
  const first = Array.from({ length: 100 }, (_, i) => 1000 + 100 * i)
    .find(now => nextArtworkPolarity(false, artworkFadeColor(fade, bright, now + 1600)));
  assert.ok(first !== undefined && first > 4000 && first < 9000, `cross at ${first}`);
});

test('reverse polarity changes within handoff and retains hysteresis at ambiguous greys', () => {
  const reverse = { ...fade, from: bright };
  const first = Array.from({ length: 100 }, (_, i) => 1000 + 100 * i)
    .find(now => !nextArtworkPolarity(true, artworkFadeColor(reverse, dark, now + 1600)));
  assert.ok(first !== undefined && first > 1000 && first < 8000, `reverse at ${first}`);
  assert.equal(nextArtworkPolarity(true, [179,179,179]), true);
  assert.equal(nextArtworkPolarity(false, [179,179,179]), false);
});

test('rapid track changes can carry the visual current mix into the next crossfade', () => {
  const midsong = artworkFadeColor(fade, bright, 6000);
  const next: ArtworkPolarityFade = { source: 'third-art', from: midsong, startedAt: 6000, durationMs: 10000 };
  assert.deepEqual(artworkFadeColor(next, dark, 6000), midsong);
  assert.equal(artworkFadeProgress(next, 7000), .1);
  assert.deepEqual(artworkFadeColor(next, dark, 16000), dark);
});

test('foreground palette and CRT route from ambient artwork, not late semantic title swap', () => {
  const source = readFileSync(new URL('../components/skins/sxntax/SxntaxSkin.tsx', import.meta.url), 'utf8');
  assert.match(source, /const ambientCoverColors = useCoverColors\(ambientCoverSrc\)/);
  assert.match(source, /onArtworkLoaded=\{beginArtworkPolarityFade\}/);
  assert.match(source, /ambientCoverColors\.source === ambientCoverSrc/);
  assert.match(source, /artworkFadeColor\(fade, target, now \+ 1600\)/);
  assert.doesNotMatch(source, /setLightAmbient\(previous => previous \? ambientLuma/);
  const css = readFileSync(new URL('../components/skins/sxntax/Sxntax.module.css', import.meta.url), 'utf8');
  assert.match(css, /@property --sx-fg/);
  assert.match(css, /--sx-opposing 3200ms/);
});

test('invalid clock deltas do not produce out-of-range mixture', () => {
  assert.equal(artworkFadeProgress(fade, NaN), 0);
  assert.equal(artworkFadeProgress(fade, -10), 0);
  assert.equal(artworkFadeProgress(fade, Infinity), 0);
  assert.deepEqual(blendArtworkRgb(dark, bright, 100), bright);
  assert.deepEqual(blendArtworkRgb(dark, bright, NaN), dark);
});
