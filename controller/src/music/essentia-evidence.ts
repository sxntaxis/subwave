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
import type { MusicEvidenceV2 } from './musical-evidence-v2.js';

export interface EssentiaReader {
  lookup(ids: readonly string[]): Promise<Map<string, EssentiaEvidence> | null>;
  search(preferences: TraitPreferences): Promise<string[] | null>;
  searchJoint?(request: { preferences: JointEvidencePreference[]; requiredFamilies?: string[];
    eligibleIds?: string[] | null; limit?: number }): Promise<JointEvidenceResult | null>;
  lookupV2?(ids: readonly string[]): Promise<Map<string, MusicEvidenceV2> | null>;
  /** Opt-in v2.2 diagnostic lookup. Legacy clients retain null fail-open. */
  lookupV2Result?(ids: readonly string[]): Promise<MusicEvidenceLookupResult>;

}

/** A physical envelope failure is not evidence absence or a provider failure. */
export type MusicEvidenceLookupResult =
  | { status: 'ok'; rows: Map<string, MusicEvidenceV2> }
  | { status: 'transport_limit'; boundary: 'request' | 'response' }
  | { status: 'unavailable'; reason: 'invalid_request' | 'busy' | 'timeout' | 'connection'
      | 'malformed_response' | 'unknown' };

/** Read an optional detailed contract; fixtures and older readers stay fail-open. */
export async function lookupV2WithStatus(reader: EssentiaReader, ids: readonly string[]): Promise<MusicEvidenceLookupResult> {
  if (reader.lookupV2Result) return reader.lookupV2Result(ids);
  const rows = await reader.lookupV2?.(ids);
  return rows ? { status: 'ok', rows } : { status: 'unavailable', reason: 'unknown' };
}

export interface JointEvidencePreference {
  family: 'arousal' | 'valence' | 'danceability' | 'voice' | 'timbre' | 'mood' | 'instrument';
  key: string;
  direction: 'high' | 'low';
  weight?: number;
}
export interface JointEvidenceResult {
  results: Array<{ id: string; tier: 'full' | 'partial'; score: number; evidenceCoverage: number;
    matchedPreferences: number; requestedPreferences: number }>;
  rankedCount: number;
  rejectedFreshness: number;
  checkedCount?: number;
  verificationLimited?: boolean;
}

/**
 * The socket deadline is a transport safety ceiling, not a requirement that
 * musical discovery finish in one second. Keep the legacy default unchanged;
 * an operator can opt the v2 joint-search call into a longer bounded wait.
 * A separate, airtime-aware picker deadline will later decide whether to start
 * a new discovery request at all.
 */
const JOINT_SOCKET_DEFAULT_TIMEOUT_MS = 1000;
const JOINT_SOCKET_MAX_TIMEOUT_MS = 7500;
function jointSocketTimeoutMs(): number {
  const value = process.env.SUBWAVE_ESSENTIA_JOINT_TIMEOUT_MS;
  if (value === undefined) return JOINT_SOCKET_DEFAULT_TIMEOUT_MS;
  // Never silently accept a malformed or unbounded configuration.
  if (!/^[1-9]\d*$/.test(value)) return JOINT_SOCKET_DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= JOINT_SOCKET_DEFAULT_TIMEOUT_MS
    && parsed <= JOINT_SOCKET_MAX_TIMEOUT_MS ? parsed : JOINT_SOCKET_DEFAULT_TIMEOUT_MS;
}

/** Additive v2 query; timeout/unavailability returns null, never a fabricated result. */
export function searchJointSocket(
  path: string,
  request: { preferences: JointEvidencePreference[]; requiredFamilies?: string[];
    eligibleIds?: string[] | null; limit?: number },
): Promise<JointEvidenceResult | null> {
  return queryV2Socket(path, { version: 2, op: 'searchJoint', ...request }, jointSocketTimeoutMs()).then(value => {
    if (!value || typeof value !== 'object') return null;
    const result = value as JointEvidenceResult;
    if (!Array.isArray(result.results) || !Number.isInteger(result.rankedCount)
        || !Number.isInteger(result.rejectedFreshness)) return null;
    return result;
  });
}

/** Detailed evidence for existing IDs; no filesystem path reaches the client. */
export function lookupMusicEvidenceSocket(path: string, ids: readonly string[]): Promise<Map<string, MusicEvidenceV2> | null> {
  if (!ids.length || ids.length > 12 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !id || id.length > 256)) return Promise.resolve(null);
  return queryV2Socket(path, { version: 2, op: 'profiles', ids }).then(value => {
    if (!Array.isArray(value) || value.length > ids.length) return null;
    const allowed = new Set(ids);
    const result = new Map<string, MusicEvidenceV2>();
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string'
          || !allowed.has(pair[0]) || result.has(pair[0]) || !pair[1] || pair[1].trackId !== pair[0]
          || !Array.isArray(pair[1].windows)) return null;
      result.set(pair[0], pair[1] as MusicEvidenceV2);
    }
    return result;
  });
}

function queryV2Socket(path: string, request: object, timeoutMs = 1000): Promise<unknown | null> {
  if (inFlight >= 2) return Promise.resolve(null);
  const message = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(message) > 32768) return Promise.resolve(null);
  inFlight++;
  return new Promise(resolve => {
    let done = false;
    let output = '';
    const socket = createConnection(path);
    const finish = (value: unknown | null) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      inFlight--;
      socket.destroy();
      resolve(value);
    };
    const deadline = setTimeout(() => finish(null), timeoutMs);
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
    socket.on('connect', () => socket.write(message));
    socket.on('data', chunk => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) return finish(null);
      const end = output.indexOf('\n');
      if (end < 0) return;
      try {
        const value = JSON.parse(output.slice(0, end));
        finish(value);
      } catch { finish(null); }
    });
  });
}

/**
 * v2.2 negotiated diagnostics: the host answers with an explicit envelope
 * failure only when reportLimits is true. The legacy socket result shape and
 * the legacy null failure semantics remain unchanged.
 */
export async function lookupMusicEvidenceSocketResult(
  path: string, ids: readonly string[],
): Promise<MusicEvidenceLookupResult> {
  if (!ids.length || ids.length > 12 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !id || id.length > 256)) {
    return { status: 'unavailable', reason: 'invalid_request' };
  }
  const response = await queryV2SocketWithStatus(path, { version: 2, op: 'profiles', ids, reportLimits: true });
  if (response.status !== 'ok') return response;
  if (response.value && typeof response.value === 'object' && !Array.isArray(response.value)
      && (response.value as { version?: unknown }).version === 2
      && (response.value as { error?: unknown }).error === 'response_too_large') {
    return { status: 'transport_limit', boundary: 'response' };
  }
  if (response.value === null) return { status: 'unavailable', reason: 'unknown' };
  const rows = validateV2Profiles(response.value, ids);
  return rows ? { status: 'ok', rows } : { status: 'unavailable', reason: 'malformed_response' };
}

type SocketResult = { status: 'ok'; value: unknown }
  | Exclude<MusicEvidenceLookupResult, { status: 'ok'; rows: Map<string, MusicEvidenceV2> }>;

/** Strict byte envelopes, clear failures, and no request-specific identifiers in diagnostic messages. */
function queryV2SocketWithStatus(path: string, request: object): Promise<SocketResult> {
  if (inFlight >= 2) return Promise.resolve({ status: 'unavailable', reason: 'busy' });
  const message = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(message) > 32768) return Promise.resolve({ status: 'transport_limit', boundary: 'request' });
  inFlight++;
  return new Promise(resolve => {
    let done = false;
    let output = Buffer.alloc(0);
    const socket = createConnection(path);
    const finish = (result: SocketResult) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      inFlight--;
      socket.destroy();
      resolve(result);
    };
    const deadline = setTimeout(() => finish({ status: 'unavailable', reason: 'timeout' }), 1000);
    socket.on('error', () => finish({ status: 'unavailable', reason: 'connection' }));
    socket.on('close', () => finish({ status: 'unavailable', reason: 'connection' }));
    socket.on('connect', () => socket.write(message));
    socket.on('data', (chunk: Buffer) => {
      const incoming = Buffer.concat([output, chunk]);
      const end = incoming.indexOf(10);
      // The bound applies to the JSON payload, not its line delimiter.
      const bodySize = end >= 0 ? end : incoming.length;
      if (bodySize > 2 * 1024 * 1024) return finish({ status: 'transport_limit', boundary: 'response' });
      if (end < 0) { output = incoming; return; }
      try {
        finish({ status: 'ok', value: JSON.parse(incoming.subarray(0, end).toString('utf8')) });
      } catch { finish({ status: 'unavailable', reason: 'malformed_response' }); }
    });
  });
}

function validateV2Profiles(value: unknown, ids: readonly string[]): Map<string, MusicEvidenceV2> | null {
  if (!Array.isArray(value) || value.length > ids.length) return null;
  const allowed = new Set(ids);
  const result = new Map<string, MusicEvidenceV2>();
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string'
        || !allowed.has(pair[0]) || result.has(pair[0]) || !pair[1] || pair[1].trackId !== pair[0]
        || !Array.isArray(pair[1].windows)) return null;
    result.set(pair[0], pair[1] as MusicEvidenceV2);
  }
  return result;
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
  return { ...readerFromQuery(query), searchJoint: request => searchJointSocket(path, request),
    lookupV2: ids => lookupMusicEvidenceSocket(path, ids),
    lookupV2Result: ids => lookupMusicEvidenceSocketResult(path, ids) };
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
