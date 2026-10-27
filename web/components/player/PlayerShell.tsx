'use client';

// Single-skin player shell. SXNTAX is the only supported public face, so the
// hot path no longer hydrates registry resolution, localStorage skin overrides,
// skin/theme cycling, or the skin-selection context just to arrive at SXNTAX.
// Explicit `skin` is retained for isolated previews/tests.

import dynamic from 'next/dynamic';
import { Suspense, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import type { SkinComponent } from '@/components/skins/types';
import { PlayerCoreProvider, usePlayerAudio, usePlayerFeed } from './PlayerCore';
import { StationPasswordGate, useStationAuth } from './StationGate';

const SxntaxSkin = dynamic(() => import('@/components/skins/sxntax/SxntaxSkin')) as SkinComponent;

export interface PlayerShellProps {
  /** Explicit skin for previews/tests; production always uses SXNTAX. */
  skin?: SkinComponent;
  /** Rendered inside a showcase frame rather than full-page. */
  contained?: boolean;
}

export default function PlayerShell({ skin, contained = false }: PlayerShellProps) {
  return (
    <PlayerCoreProvider>
      <ShellChrome skin={skin} contained={contained} />
    </PlayerCoreProvider>
  );
}

function ShellChrome({ skin, contained }: { skin?: SkinComponent; contained: boolean }) {
  const { attachAudio } = usePlayerAudio();
  const { state } = usePlayerFeed();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  useEffect(() => { if (contained) setPortalNode(rootRef.current); }, [contained]);

  const Skin = skin ?? SxntaxSkin;

  // Private-station gate (#478): no skin and no <audio> element until the
  // password is accepted. 'checking' counts as hidden so stored-token
  // validation cannot flash the face to a locked-out visitor.
  const auth = useStationAuth();
  const hideFace = state.privacy?.privatePlayer === true && auth.phase !== 'ok';

  return (
    <div
      ref={rootRef}
      className={cn(
        contained ? 'absolute' : 'fixed',
        'inset-0 overflow-hidden bg-bg text-ink',
      )}
    >
      {hideFace ? (
        <StationPasswordGate phase={auth.phase} unlock={auth.unlock} solid />
      ) : (
        <>
          <audio ref={attachAudio} crossOrigin="anonymous" preload="none" />
          <Suspense fallback={null}>
            <Skin contained={contained} portalNode={portalNode} />
          </Suspense>
          <StationPasswordGate phase={auth.phase} unlock={auth.unlock} solid={false} />
        </>
      )}
    </div>
  );
}
