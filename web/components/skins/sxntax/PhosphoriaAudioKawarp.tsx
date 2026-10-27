'use client';

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Kawarp } from '@kawarp/react';
import { useAnalyser } from '@/lib/hooks';
import {
  analyseMaterialSpectrum, advanceMaterial, createMaterialState,
  materialTextHalo, materialUniforms, settleMaterialAfterVisibility,
} from './phosphoriaMaterial';
import { installKawarpMaterialBridge, type MaterialBridgeStatus } from './kawarpMaterialBridge';
import styles from './Sxntax.module.css';

/**
 * The original Kawarp image, deformation, blur and crossfade remain the entire
 * background. Audio changes shader uniforms, not a second canvas, image zoom,
 * or per-frame React animation props.
 */
export default function PhosphoriaAudioKawarp({
  coverSrc, onArtworkLoaded, audioRef, tunedIn, animationSpeed, transitionDuration, transitionIntensityRef, emphasisTargetRef,
}: {
  coverSrc: string;
  onArtworkLoaded: (source: string) => void;
  audioRef: RefObject<HTMLAudioElement | null>;
  tunedIn: boolean;
  animationSpeed: number;
  transitionDuration: number;
  transitionIntensityRef: { current: number };
  emphasisTargetRef: RefObject<HTMLDivElement | null>;
}) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(createMaterialState());
  const enabledRef = useRef(true);
  const [bridgeStatus, setBridgeStatus] = useState<MaterialBridgeStatus>('armed');
  const [reducedMotion, setReducedMotion] = useState(false);
  const { ready, read, sampleRate } = useAnalyser(audioRef, tunedIn);

  useLayoutEffect(() => {
    const canvas = fieldRef.current?.querySelector('canvas');
    if (!canvas) { setBridgeStatus('no-webgl'); return; }
    return installKawarpMaterialBridge(canvas, () => stateRef.current,
      () => enabledRef.current, setBridgeStatus);
  }, []);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0, previousFrame = 0, lastEvidence = 0;
    let hiddenAt: number | null = document.hidden ? performance.now() : null;
    let previousBands: number[] | null = null;
    let sampleFrames = 0;
    let lastHalo = -1;
    const tick = (now: number) => {
      if (document.hidden || reduced.matches) return;
      const dt = previousFrame ? Math.min(.06, Math.max(0, (now - previousFrame) / 1000)) : 1 / 60;
      previousFrame = now;
      const sample = tunedIn && ready ? analyseMaterialSpectrum(read(), sampleRate, previousBands) : null;
      const signal = sample && sample.spectrum.overall > .005 ? sample.spectrum : null;
      previousBands = signal ? sample!.bands : null;
      stateRef.current = advanceMaterial(stateRef.current, signal, dt, transitionIntensityRef.current);
      sampleFrames++;
      // The typographic halo is the emissive/imprint output of this channel.
      // Throttle style mutations by quantizing to 0.5 percentage points;
      // no React render and no modification to Kawarp's color brightness.
      const halo = materialTextHalo(stateRef.current);
      const quantized = Math.round(halo * 2) / 2;
      if (quantized !== lastHalo) {
        emphasisTargetRef.current?.style.setProperty('--sx-audio-halo', `${quantized.toFixed(1)}%`);
        lastHalo = quantized;
      }
      if (now - lastEvidence >= 750) {
        lastEvidence = now;
        const field = fieldRef.current;
        if (field) {
          const grade = materialUniforms(stateRef.current);
          field.dataset.materialSource = signal ? 'audio' : 'passive';
          field.dataset.materialEnergy = signal ? signal.overall.toFixed(3) : '0.000';
          field.dataset.materialFlux = signal ? signal.flux.toFixed(3) : '0.000';
          field.dataset.materialOnsets = String(stateRef.current.onsetCount);
          field.dataset.materialWarp = grade[0].toFixed(3);
          field.dataset.materialTextHalo = halo.toFixed(2);
          field.dataset.materialContrast = grade[1].toFixed(3);
          field.dataset.materialSaturation = grade[2].toFixed(3);
          field.dataset.materialFrames = String(sampleFrames);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    const restart = () => {
      setReducedMotion(reduced.matches);
      cancelAnimationFrame(raf);
      previousBands = null;
      previousFrame = 0;
      enabledRef.current = !reduced.matches && !document.hidden;
      if (reduced.matches) {
        emphasisTargetRef.current?.style.removeProperty('--sx-audio-halo');
        lastHalo = -1;
        stateRef.current = settleMaterialAfterVisibility(stateRef.current, 6);
        return;
      }
      if (!document.hidden) raf = requestAnimationFrame(tick);
    };
    const visibility = () => {
      if (document.hidden) {
        hiddenAt = performance.now();
        emphasisTargetRef.current?.style.removeProperty('--sx-audio-halo');
        lastHalo = -1;
      }
      else if (hiddenAt !== null) {
        stateRef.current = settleMaterialAfterVisibility(stateRef.current,
          (performance.now() - hiddenAt) / 1000);
        hiddenAt = null;
      }
      restart();
    };
    document.addEventListener('visibilitychange', visibility);
    reduced.addEventListener('change', restart);
    restart();
    return () => {
      cancelAnimationFrame(raf);
      emphasisTargetRef.current?.style.removeProperty('--sx-audio-halo');
      document.removeEventListener('visibilitychange', visibility);
      reduced.removeEventListener('change', restart);
    };
  }, [ready, read, sampleRate, transitionIntensityRef, tunedIn, emphasisTargetRef]);

  return (
    <div ref={fieldRef} className={styles.kawarp} data-phosphoria-fluid="graded-kawarp"
      data-material-bridge={bridgeStatus} aria-hidden="true">
      <Kawarp src={coverSrc} onLoad={() => onArtworkLoaded(coverSrc)} dithering={0} warpIntensity={1}
        animationSpeed={reducedMotion ? 0 : animationSpeed} saturation={1.5} scale={1}
        transitionDuration={transitionDuration} className={styles.kawarpCanvas} />
    </div>
  );
}
