'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import PhosphoriaAudioKawarp from './PhosphoriaAudioKawarp';
import NewpixieCrtOverlay, { type CrtTransitionProfile } from './NewpixieCrtOverlay';
import styles from './Sxntax.module.css';

export default function SxntaxFullEffects({
  coverSrc,
  audioRef,
  tunedIn,
  animationSpeed,
  transitionDuration,
  transitionIntensityRef,
  transitionProfile,
  lightAmbient,
  onArtworkLoaded,
  emphasisTargetRef,
  onReady,
}: {
  coverSrc: string | null;
  audioRef: RefObject<HTMLAudioElement | null>;
  tunedIn: boolean;
  animationSpeed: number;
  transitionDuration: number;
  transitionIntensityRef: { current: number };
  transitionProfile: CrtTransitionProfile;
  lightAmbient: boolean;
  onArtworkLoaded: (source: string) => void;
  emphasisTargetRef: RefObject<HTMLDivElement | null>;
  onReady: () => void;
}) {
  const readyRef = useRef(false);
  const crtReadyRef = useRef(false);
  const settleReadyRef = useRef(false);
  const tryReady = useCallback(() => {
    if (readyRef.current || !crtReadyRef.current || !settleReadyRef.current) return;
    readyRef.current = true;
    onReady();
  }, [onReady]);

  const handleFirstFrame = useCallback(() => {
    crtReadyRef.current = true;
    tryReady();
  }, [tryReady]);

  // Give the lazy chunk/Kawarp surface a few compositor frames to exist before
  // dissolving the gate. A bounded fallback still prevents WebGL failure from
  // trapping the listener.
  useEffect(() => {
    const settle = window.setTimeout(() => {
      settleReadyRef.current = true;
      tryReady();
    }, 420);
    const fallback = window.setTimeout(() => {
      if (readyRef.current) return;
      readyRef.current = true;
      onReady();
    }, 1400);
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(fallback);
    };
  }, [onReady, tryReady]);

  return (
    <>
      {coverSrc && (
        <PhosphoriaAudioKawarp
          coverSrc={coverSrc}
          onArtworkLoaded={onArtworkLoaded}
          audioRef={audioRef}
          tunedIn={tunedIn}
          animationSpeed={animationSpeed}
          transitionDuration={transitionDuration}
          transitionIntensityRef={transitionIntensityRef}
          emphasisTargetRef={emphasisTargetRef}
        />
      )}
      <NewpixieCrtOverlay
        className={styles.crt}
        transitionIntensityRef={transitionIntensityRef}
        transitionProfile={transitionProfile}
        lightAmbient={lightAmbient}
        onFirstFrame={handleFirstFrame}
      />
    </>
  );
}
