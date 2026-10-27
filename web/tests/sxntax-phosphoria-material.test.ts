import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  advanceMaterial, analyseMaterialSpectrum, createMaterialState, materialUniforms, materialTextHalo,
  PHOSPHORIA_MATERIAL, settleMaterialAfterVisibility,
} from '../components/skins/sxntax/phosphoriaMaterial.ts';
import {
  injectPhosphoriaMaterial, injectPhosphoriaGrade, installKawarpMaterialBridge,
} from '../components/skins/sxntax/kawarpMaterialBridge.ts';

const signal = (s: Record<string, number> = {}) => ({ bass: .2, mids: .2, highs: .2, overall: .2, flux: 0, ...s });
const warpSource = `precision highp float; uniform float u_intensity;
  float snoise(vec2 v) {return v.x;}
  void main(){ vec2 uv=vec2(0.5); vec2 warp=vec2(0.);
  vec2 warpedUV = uv + warp * u_intensity; }`;
const gradeSource = `precision highp float; uniform float u_saturation;
  uniform float u_dithering; uniform float u_scale;
  void main(){ vec4 color=vec4(0.); gl_FragColor = color; }`;

test('absent audio leaves the original shader exactly neutral', () => {
  const state = createMaterialState();
  assert.deepEqual(materialUniforms(state), [1, 1, 1]);
  const still = advanceMaterial(state, null, .016);
  assert.deepEqual(materialUniforms(still), [1, 1, 1]);
});

test('steady bass drives more deformation, without any scale or wave fields', () => {
  let quiet = createMaterialState(), loud = createMaterialState();
  for (let i = 0; i < 120; i++) {
    quiet = advanceMaterial(quiet, signal({ overall: .04, bass: .04 }), 1/60);
    loud = advanceMaterial(loud, signal({ overall: .75, bass: .85 }), 1/60);
  }
  assert.ok(loud.deformation > quiet.deformation);
  assert.ok(materialUniforms(loud)[0] > materialUniforms(quiet)[0]);
  assert.ok(!('waves' in loud));
  assert.ok(!('scale' in loud));
});

test('energy strengthens foreground halo, contrast and saturation independently', () => {
  let state = createMaterialState();
  for (let i = 0; i < 120; i++) state = advanceMaterial(state, signal({ overall: .62 }), 1/60);
  const [, contrast, sat] = materialUniforms(state);
  assert.ok(materialTextHalo(state) > 1 && materialTextHalo(state) <= 34);
  assert.ok(contrast > 1.03 && contrast <= 1.18);
  assert.ok(sat > 1.02 && sat <= 1.15);
});

test('a new spectral transient briefly strengthens the existing warp and grade', () => {
  let steady = createMaterialState();
  for (let i = 0; i < 50; i++) steady = advanceMaterial(steady, signal(), 1/60);
  const quiet = steady;
  let onset = advanceMaterial(steady, signal({ flux: .82 }), 1/60);
  for (let i = 0; i < 8; i++) onset = advanceMaterial(onset, signal({flux: 0}), 1/60);
  assert.ok(onset.transient > 0);
  assert.ok(materialUniforms(onset)[0] > materialUniforms(quiet)[0]);
  assert.ok(materialUniforms(onset)[2] > materialUniforms(quiet)[2]);
});

test('a constant novelty spike cannot synthesize repeated pulses', () => {
  let state = createMaterialState();
  for (let i = 0; i < 180; i++) state = advanceMaterial(state, signal({flux: .42}), 1/60);
  assert.equal(state.onsetCount, 1);
  for (let i = 0; i < 30; i++) state = advanceMaterial(state, signal(), 1/60);
  state = advanceMaterial(state, signal({flux: .75}), 1/60);
  assert.equal(state.onsetCount, 2);
});

test('silence gradually relaxes visual grade to unchanged Kawarp', () => {
  let state = createMaterialState();
  for (let i = 0; i < 90; i++) state = advanceMaterial(state, signal({ overall: .75, bass: .9 }), 1/60);
  const before = materialUniforms(state);
  for (let i = 0; i < 360; i++) state = advanceMaterial(state, null, 1/60);
  const after = materialUniforms(state);
  assert.ok(after[0] < before[0] && after[1] < before[1]);
  assert.ok(Math.abs(after[0] - 1) < .005);
  assert.ok(Math.abs(after[2] - 1) < .005);
});

test('station handoff does not emit fake beats and retains artwork crossfade ownership', () => {
  let state = createMaterialState();
  for (let i = 0; i < 30; i++) state = advanceMaterial(state, null, 1/60, 1);
  assert.equal(state.onsetCount, 0);
  assert.ok(state.handoff > 0);
  assert.ok(materialUniforms(state)[0] > 1);
});

test('zero elapsed frame and absent signal cannot trigger an onset', () => {
  const state = advanceMaterial(createMaterialState(), signal({flux: .9}), 0);
  assert.equal(state.onsetCount, 0);
  assert.equal(state.time, 0);
});

test('byte FFT bands remain stable under silence and identify bass versus treble', () => {
  const empty = new Uint8Array(2048);
  assert.equal(analyseMaterialSpectrum(null, 44100, null), null);
  assert.equal(analyseMaterialSpectrum(empty, 44100, null)?.spectrum.overall, 0);
  const bass = new Uint8Array(2048); bass.fill(230, 5, 22);
  const highs = new Uint8Array(2048); highs.fill(230, 200, 300);
  const a = analyseMaterialSpectrum(bass, 44100, null)!.spectrum;
  const b = analyseMaterialSpectrum(highs, 44100, null)!.spectrum;
  assert.ok(a.bass > a.highs);
  assert.ok(b.highs > b.bass);
});

test('adapts reasonably to quiet masters without amplifying digital silence', () => {
  let state = createMaterialState();
  for (let i = 0; i < 1200; i++) state = advanceMaterial(state, signal({overall:.12,bass:.14}), 1/60);
  assert.ok(state.energy > .3);
  for (let i = 0; i < 600; i++) state = advanceMaterial(state, null, 1/60);
  assert.ok(materialUniforms(state)[1] - 1 < .004);
});

test('different FPS converge to the same optical state', () => {
  const evolve = (fps: number) => {
    let s = createMaterialState();
    for (let i = 0; i < fps*3; i++) s = advanceMaterial(s, signal({overall:.67,bass:.78}), 1/fps);
    return materialUniforms(s);
  };
  const a = evolve(30), b = evolve(60), c = evolve(144);
  for (let k=0; k<3; k++) {
    assert.ok(Math.abs(a[k]! - b[k]!) < .005);
    assert.ok(Math.abs(c[k]! - b[k]!) < .005);
  }
});

test('material controls independently disable each optical response', () => {
  const state = advanceMaterial(createMaterialState(), signal({overall:.9}), .05);
  const c = PHOSPHORIA_MATERIAL;
  assert.equal(materialUniforms(state, true, {...c, warpStrength:0})[0], 1);
  assert.equal(materialTextHalo(state, true, {...c, textEmphasisStrength:0}), 0);
  assert.equal(materialUniforms(state, true, {...c, contrastStrength:0})[1], 1);
  assert.equal(materialUniforms(state, true, {...c, saturationStrength:0})[2], 1);
  assert.deepEqual(materialUniforms(state, false), [1,1,1]);
});

test('background tab decay produces no backlog or imaginary onset', () => {
  let state = createMaterialState();
  state = advanceMaterial(state, signal({flux:.9,overall:.8}), .05);
  const before = state.onsetCount;
  const settled = settleMaterialAfterVisibility(state, 30);
  assert.equal(settled.onsetCount, before);
  assert.ok(materialUniforms(settled)[0] < materialUniforms(state)[0]);
  assert.ok(settled.time - state.time <= 6.001);
});

test('extreme values remain bounded; no output exceeds conservative grade limits', () => {
  let state = createMaterialState();
  for (let i=0;i<6000;i++) {
    state = advanceMaterial(state, signal({overall: i % 7 ? Infinity : .9, bass: 2, highs: -2, flux: i%3?NaN:7}), 1/144, Infinity);
    const u = materialUniforms(state);
    assert.ok(u.every(Number.isFinite));
    assert.ok(u[0] >= 1 && u[0] <= 1 + PHOSPHORIA_MATERIAL.warpStrength);
    assert.ok(u[1] >= 1 && u[1] <= 1 + PHOSPHORIA_MATERIAL.contrastStrength);
    assert.ok(u[2] >= 1 && u[2] <= 1 + PHOSPHORIA_MATERIAL.saturationStrength);
    assert.ok(materialTextHalo(state) >= 0 && materialTextHalo(state) <= 34);
  }
});

test('warp patch changes the existing noise gain but no new spatial emitters appear', () => {
  const patched = injectPhosphoriaMaterial(warpSource)!;
  assert.ok(patched.includes('warp * u_intensity * u_ph_response.x'));
  assert.ok(!/wave|orbit|radius|scale|phDistortion/.test(patched));
  assert.equal(injectPhosphoriaMaterial('void main(){}'), null);
});

test('output patch grades final color without changing scale or image sampling', () => {
  const patched = injectPhosphoriaGrade(gradeSource)!;
  assert.ok(patched.includes('u_ph_response.z'));
  assert.ok(patched.includes('u_ph_response.y'));
  assert.ok(!patched.includes('u_ph_response.w'));
  assert.ok(!patched.includes('color.rgb + vec3(u_ph_response'));
  assert.ok(!patched.includes('vec2 warpedUV'));
  assert.equal(injectPhosphoriaGrade('gl_FragColor = color;'), null);
});

test('shader bridge sends the same optical response to warp and output programs', () => {
  const shaders = [0,1].map(() => ({} as WebGLShader));
  const programs = [0,1].map(() => ({} as WebGLProgram));
  const sourceForShader = new Map<WebGLShader,string>();
  let attached = shaders[0]!;
  const values: number[][] = [];
  const statuses: string[] = [];
  const gl = {
    shaderSource(s: WebGLShader, src: string) { sourceForShader.set(s,src); },
    compileShader() {}, linkProgram(_program: WebGLProgram) {}, useProgram(_program: WebGLProgram | null) {}, drawArrays() {},
    getAttachedShaders() {return [attached];}, getProgramParameter() {return true;},
    getUniformLocation() {return {} as WebGLUniformLocation;},
    uniform3fv(_: WebGLUniformLocation, value: Iterable<number>) { values.push([...value]); },
  };
  const canvas = {getContext: (name: string) => name === 'webgl' ? gl : null} as unknown as HTMLCanvasElement;
  const model = advanceMaterial(createMaterialState(), signal({overall:.85,flux:.5}), .05);
  const stop = installKawarpMaterialBridge(canvas,()=>model,()=>true,s=>statuses.push(s));
  const context = canvas.getContext('webgl') as unknown as typeof gl;
  const first = { src: warpSource, s: shaders[0]!, p: programs[0]! };
  const second = { src: gradeSource, s: shaders[1]!, p: programs[1]! };
  for (const { src, s, p } of [first,second]) {
    attached = s;
    context.shaderSource(s,src);
    context.linkProgram(p);
    context.useProgram(p);
    context.drawArrays();
    if (s === shaders[0]) assert.ok(statuses.includes('partial') && !statuses.includes('active'));
  }
  assert.ok(sourceForShader.get(shaders[0]!)!.includes('u_ph_response'));
  assert.ok(sourceForShader.get(shaders[1]!)!.includes('u_ph_response'));
  assert.deepEqual(values[0],values[1]);
  assert.ok(statuses.includes('active'));
  stop();
});

test('shader compilation failure returns to original source', () => {
  const shader = {} as WebGLShader;
  let compiled = 0, text = '';
  const statuses: string[] = [];
  const gl = {
    COMPILE_STATUS: 1,
    shaderSource(_s: WebGLShader, code: string) { text = code; },
    compileShader(_shader: WebGLShader) { compiled++; },
    getShaderParameter() {return compiled>1;},
    linkProgram() {}, useProgram() {}, drawArrays() {},
  };
  const canvas={getContext:()=>gl} as unknown as HTMLCanvasElement;
  const stop = installKawarpMaterialBridge(canvas,createMaterialState,()=>true,v=>statuses.push(v));
  const context=canvas.getContext('webgl') as unknown as typeof gl;
  context.shaderSource(shader,warpSource);
  context.compileShader(shader);
  assert.equal(compiled,2);
  assert.equal(text,warpSource);
  assert.ok(statuses.includes('shader-compile-failed'));
  stop();
});

test('bridge cleanup restores WebGL methods and canvas context property', () => {
  const gl={shaderSource(){},compileShader(){},linkProgram(){},drawArrays(){},useProgram(){}};
  const before={...gl};
  const original=()=>gl;
  const canvas={getContext:original} as unknown as HTMLCanvasElement;
  const stop=installKawarpMaterialBridge(canvas,createMaterialState,()=>true,()=>{});
  canvas.getContext('webgl');
  assert.notEqual(gl.drawArrays,before.drawArrays);
  stop();
  assert.equal(canvas.getContext,original);
  assert.equal(gl.drawArrays,before.drawArrays);
  assert.equal(gl.shaderSource,before.shaderSource);
  assert.equal(gl.linkProgram,before.linkProgram);
});

test('unpatchable DOM canvas and delayed callbacks fail without touching Kawarp', async () => {
  const original=()=>null;
  const canvas={} as HTMLCanvasElement;
  Object.defineProperty(canvas,'getContext',{value:original,configurable:false});
  const statuses:string[]=[];
  const stop=installKawarpMaterialBridge(canvas,createMaterialState,()=>true,s=>statuses.push(s));
  assert.ok(statuses.includes('no-webgl'));
  stop();
  assert.equal(canvas.getContext,original);
  const gl={shaderSource(){},compileShader(){},linkProgram(){},drawArrays(){},useProgram(){}};
  const canvas2={getContext:()=>gl} as unknown as HTMLCanvasElement;
  const messages:string[]=[];
  const stop2=installKawarpMaterialBridge(canvas2,createMaterialState,()=>true,s=>messages.push(s));
  canvas2.getContext('webgl');
  const n=messages.length;
  stop2();
  await Promise.resolve();
  assert.equal(messages.length,n);
});


test('missing output-grade uniform cannot be declared fully active', () => {
  const shader = {} as WebGLShader, program = {} as WebGLProgram;
  const statuses: string[] = [];
  const gl = {
    shaderSource(_shader: WebGLShader, _source: string) {}, compileShader() {}, linkProgram(_program: WebGLProgram) {}, useProgram(_program: WebGLProgram | null) {}, drawArrays() {},
    getAttachedShaders() { return [shader]; }, getProgramParameter() { return true; },
    getUniformLocation() { return null; }, uniform4fv() {},
  };
  const canvas = {getContext:()=>gl} as unknown as HTMLCanvasElement;
  const stop = installKawarpMaterialBridge(canvas, createMaterialState, ()=>true, s=>statuses.push(s));
  const ctx = canvas.getContext('webgl') as unknown as typeof gl;
  ctx.shaderSource(shader, gradeSource); ctx.linkProgram(program); ctx.useProgram(program); ctx.drawArrays();
  assert.ok(statuses.includes('uniform-mismatch'));
  assert.ok(!statuses.includes('active'));
  stop();
});

test('loud sustained music does not pin audio energy to a flat maximum', async () => {
  const { relativeMusicalEnergy } = await import('../components/skins/sxntax/phosphoriaMaterial.ts');
  const measured = [.12,.3,.5,.7,.9].map(level => relativeMusicalEnergy(level, .5));
  assert.ok(measured.every(v => v > 0 && v < 1));
  assert.ok(measured.every((v,i) => i===0 || v > measured[i-1]!));
  assert.ok(measured.at(-1)! - measured[0]! > .3);
  let state = createMaterialState();
  for (let i = 0; i < 600; i++) state = advanceMaterial(state, signal({overall:.74,bass:.8}),1/60);
  assert.ok(state.energy > .4 && state.energy < .95, `energy=${state.energy}`);
  const before = state.energy;
  for (let i = 0; i < 25; i++) state = advanceMaterial(state, signal({overall:.23,bass:.26}),1/60);
  assert.ok(before - state.energy > .05, 'a quieter passage actually reduces the response');
});

test('alternating passages yield differentiated deformation and text emphasis', () => {
  let state = createMaterialState();
  for (let i=0;i<600;i++) state = advanceMaterial(state, signal({overall:.4,bass:.43}), 1/60);
  const steady = materialUniforms(state);
  const halo = materialTextHalo(state);
  for (let i=0;i<35;i++) state = advanceMaterial(state, signal({overall:.88,bass:.92}),1/60);
  assert.ok(materialUniforms(state)[0] > steady[0]);
  assert.ok(materialTextHalo(state) > halo);
  const high = materialTextHalo(state);
  for (let i=0;i<90;i++) state = advanceMaterial(state, signal({overall:.17,bass:.2}),1/60);
  assert.ok(materialTextHalo(state) < high);
});
