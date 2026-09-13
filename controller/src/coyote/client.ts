import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { config } from '../config.js';

const CONTRACT_VERSION = 1;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface CoyoteTrackLocator {
  navidromeId: string;
  pathHint?: string | null;
  recordingMbid?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
}

export interface CoyoteMoodReadResult {
  coyoteTrackId: string;
  path: string;
  moods: string[];
}

export interface CoyoteManualSetResult {
  jobId: string;
  requestId: string;
  moods: string[];
  updated: number;
  tracks: Array<{
    coyoteTrackId: string;
    path: string;
    proposalId: string;
    before: string[];
    moods: string[];
    changed: boolean;
  }>;
}

export interface CoyoteSemanticRetagResult {
  applied: boolean;
  coyoteTrackId: string;
  path: string;
  outcome: string;
  moods: string[];
  proposalId?: string;
  resultId?: string;
  reused?: boolean;
  changed?: boolean;
  provider_calls?: number;
  writerStatus?: string;
  metadata?: {
    prompt_static_sha256?: string;
    actual_model?: string;
    model?: string;
    [key: string]: unknown;
  } | null;
  enrichment?: Record<string, unknown>;
}

interface CoyoteErrorBody {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

interface CoyoteEnvelope<T> {
  ok?: boolean;
  version?: number;
  requestId?: string | null;
  result?: T;
  error?: CoyoteErrorBody;
}

export class CoyoteError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CoyoteError';
    this.code = code;
    this.details = details;
  }
}

export function locatorFromSong(song: {
  id: string;
  path?: string | null;
  musicBrainzId?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
}): CoyoteTrackLocator {
  return {
    navidromeId: song.id,
    pathHint: song.path ?? null,
    recordingMbid: song.musicBrainzId ?? null,
    title: song.title ?? null,
    artist: song.artist ?? null,
    album: song.album ?? null,
    duration: song.duration ?? null,
  };
}

function request<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
  const requestId = randomUUID();
  const body = JSON.stringify({ version: CONTRACT_VERSION, requestId, op, ...payload }) + '\n';

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let received = Buffer.alloc(0);
    const socket = net.createConnection({ path: config.coyote.socketPath });

    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    const timer = setTimeout(() => {
      finishReject(new CoyoteError('COYOTE_TIMEOUT', `Coyote did not answer within ${config.coyote.timeoutMs}ms`));
    }, config.coyote.timeoutMs);

    socket.once('connect', () => socket.write(body));
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_RESPONSE_BYTES) {
        clearTimeout(timer);
        finishReject(new CoyoteError('COYOTE_PROTOCOL_ERROR', 'Coyote response exceeds 1 MiB'));
        return;
      }
      const newline = received.indexOf(0x0a);
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        const envelope = JSON.parse(received.subarray(0, newline).toString('utf8')) as CoyoteEnvelope<T>;
        if (envelope.version !== CONTRACT_VERSION) {
          throw new CoyoteError('COYOTE_PROTOCOL_ERROR', `unexpected Coyote protocol version: ${String(envelope.version)}`);
        }
        if (!envelope.ok || envelope.result === undefined) {
          throw new CoyoteError(
            envelope.error?.code || 'COYOTE_ERROR',
            envelope.error?.message || 'Coyote request failed',
            envelope.error?.details || {},
          );
        }
        settled = true;
        socket.destroy();
        resolve(envelope.result);
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'EACCES') {
        finishReject(new CoyoteError('COYOTE_UNAVAILABLE', `Coyote IPC unavailable: ${error.message}`));
      } else {
        finishReject(error);
      }
    });
    socket.once('end', () => {
      if (!settled) {
        clearTimeout(timer);
        finishReject(new CoyoteError('COYOTE_PROTOCOL_ERROR', 'Coyote closed the socket before sending a response'));
      }
    });
  });
}

export function health(): Promise<{ status: string; contractVersion: number }> {
  return request('health');
}

export function readMood(track: CoyoteTrackLocator): Promise<CoyoteMoodReadResult> {
  return request('mood.read', { track });
}

export function manualSetMoods(tracks: CoyoteTrackLocator[], moods: string[]): Promise<CoyoteManualSetResult> {
  return request('mood.manual_set', { tracks, moods });
}

export function semanticRetag(track: CoyoteTrackLocator): Promise<CoyoteSemanticRetagResult> {
  return request('mood.semantic_retag', { track });
}
