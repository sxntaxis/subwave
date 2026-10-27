'use client';

import { useEffect, useRef } from 'react';
import { advanceCrtPolarity } from './phosphoriaPolarity';

const VERTEX_SOURCE = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

// Screen-space browser adaptation of Mattias Gustavsson's newpixie CRT shader
// (slang adaptation by hunterk). The original shader samples the rendered source,
// accumulation, blur, and frame textures. A DOM overlay cannot sample the page's
// framebuffer, so this port preserves the screen-space portions we actually
// want: a subtle vertical mask, tiny flicker and the sxntax/Ghostty gold-v2
// noise. Horizontal scanlines are intentionally excluded: they became visible
// as bars during handoffs. Phosphor bloom supplies transition character instead.
const FRAGMENT_SOURCE = `
  precision highp float;

  uniform vec2 u_resolution;
  uniform float u_time;
  uniform float u_transition;
  uniform float u_flicker_gain;
  uniform float u_noise_gain;
  uniform float u_curvature_gain;
  uniform float u_light_polarity;

  #define PHI 1.61803398874989484820459
  #define NOISE_CONTENT_STRENGTH 0.06
  #define NOISE_UNIFORM_STRENGTH 0.10

  float gold_v2_noise(in vec2 xy, in float seed) {
    return fract(sin(distance(xy * PHI, xy) * seed) * xy.x * xy.y);
  }

  vec2 curve(vec2 uv) {
    uv = uv - 0.5;
    uv *= vec2(0.925, 1.095);
    float curvature = 2.0;
    uv *= curvature;
    uv.x *= 1.0 + pow(abs(uv.y) / 4.0, 2.0);
    uv.y *= 1.0 + pow(abs(uv.x) / 3.0, 2.0);
    uv /= curvature;
    uv += 0.5;
    uv = uv * 0.92 + 0.04;
    return uv;
  }

  void main() {
    vec2 fragCoord = gl_FragCoord.xy;
    vec2 uv = fragCoord / u_resolution;
    float curveMix = clamp(0.40 - u_transition * u_curvature_gain * 0.10, 0.28, 0.40);
    vec2 curvedUv = mix(curve(uv), uv, curveMix);

    // Horizontal scanlines were removed at the generator. They repeatedly
    // leaked through transition suppression and read as white/grey bars.
    // CRT character now comes from mask + noise + flicker + curvature only.
    float maskPhase = clamp(mod(fragCoord.x, 3.0) / 2.0, 0.0, 1.0);
    // The phosphor mask remains live through track handoffs. Earlier builds
    // neutralised it at crossover, which made the texture visibly disappear
    // before returning after the identity transition.
    // Dark fields: ordinary phosphor mask. Bright fields: a complementary
    // INK mask; it must darken the surface, not screen bright over black type.
    float phase = mix(maskPhase, 1.0 - maskPhase, u_light_polarity);
    float shadowMask = 1.0 - mix(0.05, 0.0675, u_light_polarity) * phase;

    float noise = smoothstep(
      0.25,
      0.75,
      gold_v2_noise(fragCoord, fract(u_time * 0.001))
    );
    float noiseStrength = NOISE_CONTENT_STRENGTH * (1.0 + u_transition * u_noise_gain);
    float noiseFactor = clamp(noise + 1.0 - noiseStrength, 0.0, 1.0);
    noiseFactor = clamp(
      noiseFactor + noise * NOISE_UNIFORM_STRENGTH / 100.0,
      0.0,
      1.0
    );

    float flickerStrength = 0.0018 * (1.0 + u_transition * u_flicker_gain);
    float flicker = 1.0 - flickerStrength *
      (sin(50.0 * u_time + curvedUv.y * 2.0) * 0.5 + 0.5);

    vec3 factor = vec3(shadowMask * noiseFactor * flicker);
    gl_FragColor = vec4(clamp(factor, 0.0, 1.0), 1.0);
  }
`;

export type CrtTransitionProfile = {
  flickerGain: number;
  noiseGain: number;
  curvatureGain: number;
};

export default function NewpixieCrtOverlay({
  className,
  transitionIntensityRef,
  transitionProfile,
  lightAmbient,
  onFirstFrame,
}: {
  className?: string;
  transitionIntensityRef?: { current: number };
  transitionProfile?: CrtTransitionProfile;
  lightAmbient: boolean;
  onFirstFrame?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const firstFrameRef = useRef(false);
  const lightAmbientRef = useRef(lightAmbient);
  lightAmbientRef.current = lightAmbient;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'low-power',
    });
    if (!gl) return;

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    if (!vertex || !fragment) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      return;
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );

    gl.useProgram(program);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const resolution = gl.getUniformLocation(program, 'u_resolution');
    const time = gl.getUniformLocation(program, 'u_time');
    const transition = gl.getUniformLocation(program, 'u_transition');
    const flickerGain = gl.getUniformLocation(program, 'u_flicker_gain');
    const noiseGain = gl.getUniformLocation(program, 'u_noise_gain');
    const curvatureGain = gl.getUniformLocation(program, 'u_curvature_gain');
    const lightPolarity = gl.getUniformLocation(program, 'u_light_polarity');

    const resize = () => {
      const width = Math.max(1, Math.round(canvas.clientWidth));
      const height = Math.max(1, Math.round(canvas.clientHeight));
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    };

    let frame = 0;
    let running = !document.hidden;
    const start = performance.now();
    let lastDrawAt = 0;
    // Follow the foreground's multi-second CSS polarity transition; switching
    // the CRT mask phase in one frame would make the texture visibly jump.
    let polarity = lightAmbientRef.current ? 1 : 0;
    const draw = (now: number) => {
      frame = 0;
      if (!running || document.hidden) return;
      const elapsed = lastDrawAt ? Math.min(.1, Math.max(0, (now - lastDrawAt) / 1000)) : 0;
      lastDrawAt = now;
      const target = lightAmbientRef.current ? 1 : 0;
      polarity = advanceCrtPolarity(polarity, target, elapsed);
      resize();
      gl.useProgram(program);
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, (now - start) / 1000);
      gl.uniform1f(transition, transitionIntensityRef?.current ?? 0);
      gl.uniform1f(flickerGain, transitionProfile?.flickerGain ?? 0);
      gl.uniform1f(noiseGain, transitionProfile?.noiseGain ?? 0);
      gl.uniform1f(curvatureGain, transitionProfile?.curvatureGain ?? 0);
      gl.uniform1f(lightPolarity, polarity);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!firstFrameRef.current) {
        firstFrameRef.current = true;
        onFirstFrame?.();
      }
      schedule();
    };
    const schedule = () => {
      if (running && !frame && !document.hidden) frame = requestAnimationFrame(draw);
    };
    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(frame);
        frame = 0;
        lastDrawAt = 0;
      } else if (!running) {
        running = true;
        lastDrawAt = 0;
        schedule();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    schedule();

    return () => {
      running = false;
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAnimationFrame(frame);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
  }, [onFirstFrame, transitionIntensityRef, transitionProfile]);

  return <canvas ref={ref} className={className}
    data-crt-polarity={lightAmbient ? 'imprint' : 'emission'} aria-hidden="true" />;
}
