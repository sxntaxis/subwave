// The picker depends on a bounded asynchronous evidence reader, not on the
// workers' writable SQLite database. A production index reader must validate
// source identity and freshness before returning a row.
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { audioProfile, traitScore, type EssentiaEvidence, type TraitPreferences } from './essentia-traits.js';

export interface EssentiaReader {
  lookup(ids: readonly string[]): Promise<Map<string, EssentiaEvidence> | null>;
  search(preferences: TraitPreferences): Promise<string[] | null>;
}

const fixture = new AsyncLocalStorage<EssentiaReader>();
export function withEssentiaReaderForTest<T>(reader: EssentiaReader, fn: () => T): T {
  return fixture.run(reader, fn);
}

const helper = fileURLToPath(new URL('./essentia-index-reader.mjs', import.meta.url));
let inFlight = 0;
export function createEssentiaReader(path: string, expectedModelsHash?: string, sourcePath?: string): EssentiaReader {
  const query = (request: object): Promise<[string, EssentiaEvidence][] | null> => {
    if (inFlight >= 2) return Promise.resolve(null);
    inFlight++;
    return new Promise(resolve => {
      execFile(process.execPath, [helper, path, JSON.stringify({ ...request, expectedModelsHash, sourcePath })],
        { timeout: 1500, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          inFlight--;
          if (error) return resolve(null);
          try {
            const rows = JSON.parse(stdout);
            resolve(Array.isArray(rows) ? rows : null);
          } catch { resolve(null); }
        });
    });
  };
  return readerFromQuery(query);
}

type Query = (request: object) => Promise<[string, EssentiaEvidence][] | null>;
function readerFromQuery(query: Query): EssentiaReader {
  return {
    async lookup(ids) {
      if (!ids.length || ids.length > 12 || new Set(ids).size !== ids.length) return null;
      const rows = await query({ kind: 'lookup', ids });
      return rows ? new Map(rows) : null;
    },
    async search(preferences) {
      const p = preferences;
      const primary = p.arousal ? ['deam:arousal', p.arousal === 'high']
        : p.valence ? ['deam:valence', p.valence === 'high']
          : p.danceability ? ['binary:danceable', p.danceability === 'high']
            : p.voice ? ['binary:voice', p.voice === 'voice']
              : p.timbre ? ['binary:bright', p.timbre === 'bright']
                : p.mood ? [`moods:${p.mood}`, true]
                  : p.instrument ? [`instruments:${p.instrument}`, true] : null;
      if (!primary) return [];
      const rows = await query({ kind: 'search', trait: primary[0], desc: primary[1] });
      if (!rows) return null;
      return rows.map(([id, evidence]) => ({ id, score: traitScore(evidence, p) }))
        .filter((x): x is { id: string; score: number } => x.score !== null)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, 128).map(x => x.id);
    },
  };
}

export function createSocketEssentiaReader(path: string): EssentiaReader {
  const query: Query = request => {
    if (inFlight >= 2) return Promise.resolve(null);
    inFlight++;
    return new Promise(resolve => {
      let settled = false;
      let output = '';
      const socket = createConnection(path);
      const finish = (rows: [string, EssentiaEvidence][] | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        inFlight--;
        socket.destroy();
        resolve(rows);
      };
      const deadline = setTimeout(() => finish(null), 1000);
      socket.setTimeout(1000, () => finish(null));
      socket.on('error', () => finish(null));
      socket.on('close', () => finish(null));
      socket.on('connect', () => {
        const input = request as { kind?: string; ids?: readonly string[]; trait?: string; desc?: boolean };
        const message = input.kind === 'lookup'
          ? { version: 1, op: 'profiles', ids: input.ids }
          : { version: 1, op: 'searchTraits', trait: input.trait, desc: input.desc };
        socket.write(JSON.stringify(message) + '\n');
      });
      socket.on('data', chunk => {
        output += chunk.toString('utf8');
        if (output.length > 2 * 1024 * 1024) return finish(null);
        const end = output.indexOf('\n');
        if (end < 0) return;
        try {
          const rows = JSON.parse(output.slice(0, end));
          finish(Array.isArray(rows) ? rows : null);
        } catch { finish(null); }
      });
    });
  };
  return readerFromQuery(query);
}

// Only a recently healthy private socket is offered to the autonomous picker.
export function getEssentiaReader(): EssentiaReader | null {
  const test = fixture.getStore();
  if (test) return test;
  const path = process.env.SUBWAVE_ESSENTIA_SOCKET;
  if (!path || !existsSync(path)) return null;
  try {
    if (!statSync(path).isSocket()) return null;
    const markerPath = join(dirname(path), 'ready.json');
    if (statSync(markerPath).size > 1024) return null;
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    const age = Date.now() - marker.updated_ms;
    if (marker.ready !== true || !Number.isFinite(age) || age < 0 || age > 30_000) return null;
    return createSocketEssentiaReader(path);
  } catch {
    return null;
  }
}

export async function enrichEssentia(reader: EssentiaReader | null, tracks: any[]): Promise<any[]> {
  if (!reader || !tracks.length || tracks.length > 12) return tracks;
  try {
    const ids = tracks.map(track => track?.id);
    if (ids.some(id => typeof id !== 'string' || !id || id.length > 256)
      || new Set(ids).size !== ids.length) return tracks;
    const rows = await reader.lookup(ids);
    if (!rows) return tracks;
    let remaining = 2048;
    return tracks.map(track => {
      const evidence = rows.get(track.id);
      const profile = evidence ? audioProfile(evidence) : null;
      if (!profile) return track;
      const size = Buffer.byteLength(JSON.stringify({ audio_profile: profile }));
      if (size > remaining) return track;
      remaining -= size;
      // seen is deliberately the original projection: profiles belong only to
      // this tool response, not to later repick prompts or persistent state.
      return { ...track, audio_profile: profile };
    });
  } catch {
    // Optional evidence must never prevent the original shortlist from airing.
  }
  return tracks;
}
