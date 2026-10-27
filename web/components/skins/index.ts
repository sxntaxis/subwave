'use client';

// Adding a skin is one entry here plus a directory under components/skins/<id>/
// (contract in types.ts). Components are wrapped in next/dynamic so only the
// active skin's chunk is fetched; SSR stays on, so first paint doesn't wait on
// a client roundtrip.

import dynamic from 'next/dynamic';
import { DEFAULT_SKIN_ID, canonicalSkinId } from '@/lib/skin';
import { SKIN_API_VERSION, type SkinComponent, type SkinManifest } from './types';

export const SKINS: SkinManifest[] = [
  {
    id: 'sxntax',
    name: 'sxntax',
    description:
      'The station face for radio.sxntax.shop — ambient artwork, Ratatui frame, and a vertical broadcast log.',
    skinApiVersion: SKIN_API_VERSION,
    load: () => import('./sxntax/SxntaxSkin'),
  },
];

// Id facts remain in lib/skin.ts for settings/backward compatibility. The
// public player no longer resolves a runtime skin because SXNTAX is the only
// supported face.
export { DEFAULT_SKIN_ID };

export function isKnownSkin(id: string | null | undefined): id is string {
  return !!id && SKINS.some(s => s.id === id);
}

/** Listener override beats station default beats built-in fallback; legacy
 *  ids map to their successor, and unknown ids (a skin removed from the
 *  build, a typo in settings) fall through so the player always renders. */
export function resolveSkinId(
  stationId: string | null | undefined,
  overrideId: string | null,
): string {
  const override = canonicalSkinId(overrideId);
  if (isKnownSkin(override)) return override;
  const station = canonicalSkinId(stationId);
  if (isKnownSkin(station)) return station;
  return DEFAULT_SKIN_ID;
}

/** Module-level dynamic wrappers, one per registered skin — referenced by
 *  plain property access so render code never looks like it's creating a
 *  component (react-hooks/static-components). */
export const SKIN_COMPONENTS: Record<string, SkinComponent> = Object.fromEntries(
  SKINS.map(m => [m.id, dynamic(m.load) as SkinComponent]),
);

/** Concretely-typed last-resort fallback for indexed lookups (the registry is
 *  a string-keyed record, so TS can't prove a hit). The bundler dedupes this
 *  against the registry entry's chunk. */
export const DEFAULT_SKIN_COMPONENT: SkinComponent = dynamic(
  () => import('./sxntax/SxntaxSkin'),
) as SkinComponent;
