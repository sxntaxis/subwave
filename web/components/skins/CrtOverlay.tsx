'use client';

import { useEffect, useRef } from 'react';
import { useLiteMode } from '@/hooks/useLiteMode';

const VERTEX_SOURCE = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

// Screen-space port of the Ghostty shader used by sxntax.shop.
const FRAGMENT_SOURCE = `
  precision highp float;
  uniform vec2 u_resolution;
  uniform float u_time;

  #define PI 3.1415926535897932384626433832795
  #define PHI 1.61803398874989484820459
  #define VIGNETTE_SPREAD 0.4
  #define VIGNETTE_BRIGHTNESS 20.0
  #define SCAN_LINES_STRENGTH 0.20
  #define SCAN_LINES_VARIANCE 0.35
  #define SCAN_LINES_PERIOD 4.0
  #define APERTURE_GRILLE_STRENGTH 0.3
  #define APERTURE_GRILLE_PERIOD 2.0
  #define FLICKER_STRENGTH 0.04
  #define FLICKER_FREQUENCY 15.0
  #define NOISE_CONTENT_STRENGTH 0.25
  #define NOISE_UNIFORM_STRENGTH 0.25
  #define CRT_STRENGTH 0.55

  float gold_v2_noise(in vec2 xy, in float seed) {
    return fract(sin(distance(xy * PHI, xy) * seed) * xy.x * xy.y);
  }

  void main() {
    vec2 fragCoord = gl_FragCoord.xy;
    vec2 uv = fragCoord / u_resolution;
    vec3 factor = vec3(0.93, 1.00, 0.96);
    float vignette = VIGNETTE_BRIGHTNESS * pow(
      clamp(uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y), 0.0, 1.0),
      VIGNETTE_SPREAD
    );
    factor *= clamp(vignette, 0.0, 1.0);
    float scan = mix(
      1.0,
      SCAN_LINES_VARIANCE / 2.0 *
        (1.0 + sin(2.0 * PI * uv.y * u_resolution.y / SCAN_LINES_PERIOD)),
      SCAN_LINES_STRENGTH
    );
    factor *= scan;
    float aperturePhase = mod(fragCoord.x, APERTURE_GRILLE_PERIOD) / APERTURE_GRILLE_PERIOD;
    float apertureMask = smoothstep(0.34, 0.50, aperturePhase) *
      (1.0 - smoothstep(0.82, 0.98, aperturePhase));
    factor *= 1.0 - APERTURE_GRILLE_STRENGTH * apertureMask;
    float flicker = 1.0 - FLICKER_STRENGTH / 2.0 *
      (1.0 + sin(2.0 * PI * FLICKER_FREQUENCY * u_time));
    factor *= flicker;
    float noise = smoothstep(0.4, 0.6, gold_v2_noise(fragCoord, fract(u_time * 0.001)));
    factor *= clamp(noise + 1.0 - NOISE_CONTENT_STRENGTH, 0.0, 1.0);
    factor = clamp(factor + noise * NOISE_UNIFORM_STRENGTH / 100.0, 0.0, 1.0);
    factor = mix(vec3(1.0), factor, CRT_STRENGTH);
    gl_FragColor = vec4(factor, 1.0);
  }
`;

export default function CrtOverlay({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const { lite } = useLiteMode();

  useEffect(() => {
    if (lite) return;
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
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
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;

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
    let lastDraw = 0;
    const start = performance.now();
    const draw = (now: number) => {
      if (!running) return;
      if (now - lastDraw >= 1000 / 30) {
        lastDraw = now;
        resize();
        gl.useProgram(program);
        gl.uniform2f(resolution, canvas.width, canvas.height);
        gl.uniform1f(time, (now - start) / 1000);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      frame = requestAnimationFrame(draw);
    };
    const onVisibility = () => {
      running = !document.hidden;
      if (running) frame = requestAnimationFrame(draw);
    };
    document.addEventListener('visibilitychange', onVisibility);
    frame = requestAnimationFrame(draw);
    return () => {
      running = false;
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAnimationFrame(frame);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
  }, [lite]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
