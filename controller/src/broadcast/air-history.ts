// Listener history is station-wide. It must not follow the DJ's prompt-memory
// session rolls, and its retention is measured in songs, not mixed timeline rows.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const AIR_HISTORY_TRACKS = 100;

export interface AirMessage {
  t: string;
  role: 'segment';
  kind: string;
  text: string;
  meta: { airedAt?: string; personaName?: string };
}

export function airMessage(value: unknown, personaName?: string): AirMessage | null {
  if (!value || typeof value !== 'object') return null;
  const turn = value as Record<string, unknown>;
  if (turn.role !== 'segment' || turn.kind === 'sfx' || turn.kind === 'jingle'
    || typeof turn.text !== 'string' || !turn.text.trim()
    || typeof turn.t !== 'string' || !Number.isFinite(Date.parse(turn.t))) return null;
  const meta = turn.meta && typeof turn.meta === 'object' ? turn.meta as Record<string, unknown> : {};
  return {
    t: turn.t,
    role: 'segment',
    kind: typeof turn.kind === 'string' ? turn.kind : 'speech',
    text: turn.text,
    // An allowlist: the listener archive never publishes prompts or TTS config.
    meta: {
      ...(typeof meta.airedAt === 'string' && Number.isFinite(Date.parse(meta.airedAt)) ? { airedAt: meta.airedAt } : {}),
      ...(typeof meta.personaName === 'string' ? { personaName: meta.personaName } : typeof personaName === 'string' ? { personaName } : {}),
    },
  };
}

export function retainAirMessages(values: unknown[], since: number | null): AirMessage[] {
  const unique = new Map<string, AirMessage>();
  for (const value of values) {
    const turn = airMessage(value);
    if (!turn || (since != null && Date.parse(turn.meta.airedAt ?? turn.t) < since)) continue;
    unique.set(`${turn.t}\u0000${turn.kind}\u0000${turn.text}`, turn);
  }
  return [...unique.values()].sort((a, b) => Date.parse(a.meta.airedAt ?? a.t) - Date.parse(b.meta.airedAt ?? b.t));
}

// Upgrade backfill only, called from queue recovery, never from a public GET.
// Existing session archives can restore speech lost from the live /session tail.
export function recoverAirMessages(currentFile: string, archiveDir: string, since: number | null): AirMessage[] {
  const files = [currentFile];
  try {
    for (const name of readdirSync(archiveDir)) {
      if (!/^sess_[a-f0-9]+\.json$/.test(name)) continue;
      const path = join(archiveDir, name);
      if (since == null || statSync(path).mtimeMs >= since) files.push(path);
    }
  } catch { /* No archived sessions on a fresh install. */ }
  const turns: AirMessage[] = [];
  for (const path of files) {
    try {
      const stored = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(stored.messages)) continue;
      for (const raw of stored.messages) {
        const turn = airMessage(raw, stored.persona?.name);
        if (turn) turns.push(turn);
      }
    } catch { /* One damaged archive must not discard the rest of history. */ }
  }
  return retainAirMessages(turns, since);
}
