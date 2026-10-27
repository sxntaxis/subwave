import { materialUniforms, type MaterialState } from './phosphoriaMaterial.ts';

/**
 * Signature-locked extension of @kawarp/core 1.2.2.
 * Modify only Kawarp's EXISTING warp and output passes. The original texture,
 * blur, artwork handoff, canvas resolution and RAF are unchanged. If shaders
 * cannot compile, restore upstream source rather than breaking the radio.
 */
export type MaterialBridgeStatus =
  'armed' | 'active' | 'partial' | 'shader-mismatch' | 'shader-compile-failed' | 'uniform-mismatch' | 'no-webgl';

type Role = 'warp' | 'grade';
const UNIFORM = 'uniform vec3 u_ph_response; // warp, contrast, saturation';

/** Keep the exact Kawarp noise field, only change its gain. No expanding waves. */
export function injectPhosphoriaMaterial(source: string): string | null {
  if (!source.includes('vec2 warpedUV = uv + warp * u_intensity;') ||
      !source.includes('uniform float u_intensity;') ||
      !source.includes('float snoise(vec2 v)')) return null;
  return source.replace('uniform float u_intensity;', `uniform float u_intensity;\n${UNIFORM}`)
    .replace('vec2 warpedUV = uv + warp * u_intensity;',
      'vec2 warpedUV = uv + warp * u_intensity * u_ph_response.x;');
}

/**
 * Color grade occurs AFTER the original Kawarp saturation/vignette/dithering.
 * No texture re-blur, scene zoom, different palette or homogeneously colored
 * overlay. Modest midtone contrast and luma-neutral chroma. No brightness addition.
 */
export function injectPhosphoriaGrade(source: string): string | null {
  if (!source.includes('uniform float u_dithering;') ||
      !source.includes('uniform float u_saturation;') ||
      !source.includes('uniform float u_scale;') ||
      !source.includes('gl_FragColor = color;')) return null;
  return source.replace('uniform float u_saturation;', `uniform float u_saturation;\n${UNIFORM}`)
    .replace('gl_FragColor = color;', `
    // Preserve the blurred artwork's local gradients; avoid gain changes to alpha.
    float phLuma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    color.rgb = mix(vec3(phLuma), color.rgb, u_ph_response.z);
    color.rgb = (color.rgb - vec3(0.42)) * u_ph_response.y + vec3(0.42);
    gl_FragColor = color;`);
}

export function installKawarpMaterialBridge(
  canvas: HTMLCanvasElement,
  getState: () => MaterialState,
  getEnabled: () => boolean,
  onStatus: (status: MaterialBridgeStatus) => void,
): () => void {
  const nativeContext = canvas.getContext.bind(canvas);
  const originalCanvasDescriptor = Object.getOwnPropertyDescriptor(canvas, 'getContext');
  let disposed = false;
  let installed = false;
  let restoreContextMethods: (() => void) | null = null;
  const notify = (status: MaterialBridgeStatus) => { if (!disposed) onStatus(status); };
  try {
    Object.defineProperty(canvas, 'getContext', {
      configurable: true,
      value: (name: string, ...args: unknown[]) => {
        const ctx = (nativeContext as unknown as (...a: unknown[]) => RenderingContext | null)(name, ...args);
        if (!ctx && (name === 'webgl' || name === 'experimental-webgl' || name === 'webgl2')) notify('no-webgl');
        if (installed || !ctx || (name !== 'webgl' && name !== 'experimental-webgl' && name !== 'webgl2')) return ctx;
        installed = true;
        const gl = ctx as WebGLRenderingContext;
        const originals = {
          shaderSource: gl.shaderSource.bind(gl), compileShader: gl.compileShader.bind(gl),
          linkProgram: gl.linkProgram.bind(gl), useProgram: gl.useProgram.bind(gl),
          drawArrays: gl.drawArrays.bind(gl),
        };
        const roleForShader = new WeakMap<WebGLShader, Role>();
        const sourceForShader = new WeakMap<WebGLShader, string>();
        const locationForProgram = new WeakMap<WebGLProgram, { role: Role; location: WebGLUniformLocation }>();
        const activeRoles = new Set<Role>();
        const patchedMethods: Array<{ name: keyof WebGLRenderingContext; original: PropertyDescriptor | undefined; replacement: unknown }> = [];
        let currentProgram: WebGLProgram | null = null;
        let roleCount = 0;
        let lastStatus: MaterialBridgeStatus = 'armed';
        let failure: MaterialBridgeStatus | null = null;
        const publish = (s: MaterialBridgeStatus) => {
          if (failure && s !== failure) return;
          if (s !== lastStatus) { lastStatus = s; notify(s); }
        };
        const fault = (s: MaterialBridgeStatus) => { failure = s; publish(s); };
        const override = (name: keyof WebGLRenderingContext, value: unknown) => {
          const original = Object.getOwnPropertyDescriptor(gl, name);
          Object.defineProperty(gl, name, { configurable: true, writable: true, value });
          patchedMethods.push({ name, original, replacement: value });
        };
        const restore = () => {
          for (const { name, original, replacement } of patchedMethods.reverse()) {
            if (Object.getOwnPropertyDescriptor(gl, name)?.value !== replacement) continue;
            if (original) Object.defineProperty(gl, name, original);
            else Reflect.deleteProperty(gl, name);
          }
          patchedMethods.length = 0;
        };
        restoreContextMethods = restore;
        try {
          override('shaderSource', (shader: WebGLShader, source: string) => {
            const warp = injectPhosphoriaMaterial(source);
            const grade = warp ? null : injectPhosphoriaGrade(source);
            if (warp || grade) {
              roleForShader.set(shader, warp ? 'warp' : 'grade');
              sourceForShader.set(shader, source);
              roleCount++;
              originals.shaderSource(shader, (warp || grade)!);
            } else originals.shaderSource(shader, source);
          });
          override('compileShader', (shader: WebGLShader) => {
            originals.compileShader(shader);
            if (roleForShader.has(shader) && !gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
              const source = sourceForShader.get(shader);
              if (source) {
                originals.shaderSource(shader, source);
                originals.compileShader(shader);
              }
              roleForShader.delete(shader);
              fault('shader-compile-failed');
            }
          });
          override('linkProgram', (program: WebGLProgram) => {
            originals.linkProgram(program);
            const shaders = gl.getAttachedShaders(program) ?? [];
            const materialShader = shaders.find(s => roleForShader.has(s));
            if (!materialShader) return;
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
              fault('shader-compile-failed');
              for (const shader of shaders) {
                const source = sourceForShader.get(shader);
                if (source) { originals.shaderSource(shader, source); originals.compileShader(shader); roleForShader.delete(shader); }
              }
              originals.linkProgram(program);
              return;
            }
            const location = gl.getUniformLocation(program, 'u_ph_response');
            if (!location) { fault('uniform-mismatch'); return; }
            locationForProgram.set(program, { role: roleForShader.get(materialShader)!, location });
          });
          override('useProgram', (p: WebGLProgram | null) => {
            currentProgram = p;
            originals.useProgram(p);
          });
          override('drawArrays', (mode: number, first: number, count: number) => {
            const entry = currentProgram && locationForProgram.get(currentProgram);
            if (entry) gl.uniform3fv(entry.location, materialUniforms(getState(), getEnabled()));
            originals.drawArrays(mode, first, count);
            if (entry) {
              activeRoles.add(entry.role);
              publish(activeRoles.size === 2 ? 'active' : 'partial');
            }
          });
          notify('armed');
          queueMicrotask(() => {
            if (!disposed && roleCount === 0) publish('shader-mismatch');
          });
        } catch {
          restore();
          fault('no-webgl');
        }
        return ctx;
      },
    });
  } catch {
    notify('no-webgl');
    return () => {};
  }
  return () => {
    if (disposed) return;
    disposed = true;
    restoreContextMethods?.();
    if (originalCanvasDescriptor) Object.defineProperty(canvas, 'getContext', originalCanvasDescriptor);
    else Reflect.deleteProperty(canvas, 'getContext');
  };
}
