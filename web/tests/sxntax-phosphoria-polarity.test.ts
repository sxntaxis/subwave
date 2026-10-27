import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { advanceMaterial, createMaterialState, materialTextHalo, materialUniforms } from '../components/skins/sxntax/phosphoriaMaterial.ts';

const read = (name: string) => readFileSync(new URL(`../components/skins/sxntax/${name}`, import.meta.url), 'utf8');

test('musical energy only affects deformation, contrast, saturation and foreground halo', () => {
  let state = createMaterialState();
  for (let i = 0; i < 180; i++) {
    state = advanceMaterial(state, { bass: .8, mids: .6, highs: .4, overall: .72, flux: 0 }, 1/60);
  }
  const uniforms = materialUniforms(state);
  assert.equal(uniforms.length, 3, 'no luminance uniform');
  assert.ok(uniforms[0] > 1 && uniforms[1] > 1 && uniforms[2] > 1);
  assert.ok(materialTextHalo(state) > 0 && materialTextHalo(state) <= 34);
  assert.equal(materialTextHalo(state, false), 0);
});

test('the Kawarp output shader contains no audio-driven brightness offset', () => {
  const bridge = read('kawarpMaterialBridge.ts');
  assert.match(bridge, /uniform vec3 u_ph_response/);
  assert.match(bridge, /uniform3fv/);
  assert.doesNotMatch(bridge, /color\.rgb\s*=\s*clamp\(color\.rgb\s*\+/);
});

test('bright polarity uses complement mask and absorptive CRT compositing', () => {
  const overlay = read('NewpixieCrtOverlay.tsx');
  const css = read('Sxntax.module.css');
  assert.match(overlay, /mix\(maskPhase, 1\.0 - maskPhase, u_light_polarity\)/);
  assert.match(overlay, /data-crt-polarity/);
  const bright = css.match(/\.fullVisuals\[data-light-ambient='true'\] \.crt\s*\{([^}]*)\}/)?.[1];
  assert.ok(bright, 'explicit bright CRT mode');
  assert.match(bright, /mix-blend-mode:\s*multiply/);
  assert.match(bright, /filter:\s*none/);
  assert.doesNotMatch(bright, /screen|invert/);
});

test('both polarities use centered text presence, rather than offset-only shadow', () => {
  const css = read('Sxntax.module.css');
  assert.match(css, /--sx-halo-near: 42%/);
  assert.match(css, /--sx-halo-near: 34%/);
  assert.match(css, /calc\(var\(--sx-halo-near\) \+ var\(--sx-audio-halo, 0%\)\)/);
  const lyrics = read('lyrics/LyricsPerspective.module.css');
  assert.match(lyrics, /\.lyrics-line\.active \.main-vocal-container/);
  assert.match(lyrics, /--sx-title-glow/);
});

test('text glow shares the analyser output and resets when it is no longer active', () => {
  const source = read('PhosphoriaAudioKawarp.tsx');
  assert.match(source, /materialTextHalo\(stateRef\.current\)/);
  assert.match(source, /emphasisTargetRef\.current\?\.style\.setProperty\('--sx-audio-halo'/);
  assert.match(source, /emphasisTargetRef\.current\?\.style\.removeProperty\('--sx-audio-halo'/);
  assert.doesNotMatch(source, /materialLuminance/);
});

test('CRT mask polarity eases in both directions, without a sudden phase jump', async () => {
  const { advanceCrtPolarity } = await import('../components/skins/sxntax/phosphoriaPolarity.ts');
  let brightness = 0;
  brightness = advanceCrtPolarity(brightness, 1, 1/60);
  assert.ok(brightness > 0 && brightness < .04);
  for (let i = 0; i < 180; i++) brightness = advanceCrtPolarity(brightness, 1, 1/60);
  assert.ok(brightness > .96 && brightness < 1);
  const firstReturn = advanceCrtPolarity(brightness, 0, 1/60);
  assert.ok(firstReturn < brightness && firstReturn > .93);
  for (let i = 0; i < 180; i++) brightness = advanceCrtPolarity(brightness, 0, 1/60);
  assert.ok(brightness < .04);
});

test('CRT polarity pacing is stable across 30/60/144 Hz and handles invalid inputs', async () => {
  const { advanceCrtPolarity } = await import('../components/skins/sxntax/phosphoriaPolarity.ts');
  const response = (fps: number) => {
    let state = 0;
    for (let i = 0; i < fps; i++) state = advanceCrtPolarity(state, 1, 1/fps);
    return state;
  };
  assert.ok(Math.abs(response(30) - response(60)) < .00001);
  assert.ok(Math.abs(response(144) - response(60)) < .00001);
  assert.equal(advanceCrtPolarity(0, 1, -100), 0);
  assert.equal(advanceCrtPolarity(0, 1, Infinity), 0);
  assert.ok(advanceCrtPolarity(1.5, -1, .05) < 1);
  const source = read('NewpixieCrtOverlay.tsx');
  assert.match(source, /advanceCrtPolarity\(polarity, target, elapsed\)/);
  assert.match(source, /cancelAnimationFrame\(frame\)/);
});
