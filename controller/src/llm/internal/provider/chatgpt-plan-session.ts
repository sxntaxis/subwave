// A single-writer-at-a-time SIWC credential store, deliberately separate from
// settings, API keys, and the station backup. The directory must be a dedicated
// owner-only mount, not a world-writable station-state directory.
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { PlanStreamError } from './chatgpt-plan-sse.js';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SHARING_SCOPE = 'chatgpt.tokens.use.direct';
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const keys = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

interface Credentials {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  earliestRefreshAt?: number;
  scopes: string[];
}
export interface PlanSessionRecord {
  version: 1;
  clientId: string;
  subject: string;
  credentials: Credentials;
  pending?: Credentials;
  pendingReceivedAt?: number;
  reauthRequired?: boolean;
}
type VerifyIdentity = (token: string, clientId: string, receivedAt?: number) => Promise<string>;

async function verifyIdentity(token: string, clientId: string, receivedAt?: number): Promise<string> {
  let result;
  try {
    result = await jwtVerify(token, keys, {
      issuer: ISSUER, audience: clientId, algorithms: ['RS256'],
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub'],
      ...(receivedAt === undefined ? {} : { currentDate: new Date(receivedAt) }),
    });
  } catch { throw new PlanStreamError('identity_verification_failed'); }
  if (!result.payload.sub) throw new PlanStreamError('invalid_identity');
  return result.payload.sub;
}

function credentials(value: unknown): Credentials {
  const v = value as Partial<Credentials> | null;
  if (!v || typeof v.accessToken !== 'string' || !v.accessToken ||
      typeof v.refreshToken !== 'string' || !v.refreshToken ||
      typeof v.idToken !== 'string' || !v.idToken ||
      typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt) ||
      (v.earliestRefreshAt !== undefined && (typeof v.earliestRefreshAt !== 'number' || !Number.isFinite(v.earliestRefreshAt))) ||
      !Array.isArray(v.scopes) || !v.scopes.every(s => typeof s === 'string')) {
    throw new PlanStreamError('invalid_session');
  }
  return v as Credentials;
}

function parseRecord(value: unknown): PlanSessionRecord {
  const v = value as Partial<PlanSessionRecord> | null;
  if (!v || v.version !== 1 || typeof v.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(v.clientId) || v.clientId === 'dynamic_agent_client' ||
      typeof v.subject !== 'string' || !v.subject) throw new PlanStreamError('invalid_session');
  if (v.pending && (typeof v.pendingReceivedAt !== 'number' || !Number.isSafeInteger(v.pendingReceivedAt) ||
      v.pendingReceivedAt <= 0 || v.pendingReceivedAt > Date.now() + 5_000)) throw new PlanStreamError('invalid_session');
  if (v.reauthRequired !== undefined && typeof v.reauthRequired !== 'boolean') throw new PlanStreamError('invalid_session');
  return {
    version: 1, clientId: v.clientId, subject: v.subject,
    credentials: credentials(v.credentials),
    ...(v.pending ? { pending: credentials(v.pending), pendingReceivedAt: v.pendingReceivedAt } : {}),
    ...(v.reauthRequired ? { reauthRequired: true } : {}),
  };
}

export class PlanSession {
  readonly #dir: string;
  readonly #path: string;
  readonly #fetch: typeof fetch;
  readonly #verify: VerifyIdentity;

  constructor(directory: string, deps: { fetch?: typeof fetch; verifyIdentity?: VerifyIdentity } = {}) {
    if (!isAbsolute(directory)) throw new PlanStreamError('invalid_session_directory');
    this.#dir = directory;
    this.#path = join(directory, 'session.json');
    this.#fetch = deps.fetch ?? fetch;
    this.#verify = deps.verifyIdentity ?? verifyIdentity;
  }

  async #prepare() {
    await mkdir(this.#dir, { mode: 0o700, recursive: true });
    const info = await lstat(this.#dir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())) throw new PlanStreamError('unsafe_session_directory');
  }

  async #locked<T>(run: () => Promise<T>): Promise<T> {
    await this.#prepare();
    // The mount's parent is normally root-owned (/run), so keep the lock
    // inside the private mount rather than beside it.
    const release = await lockfile.lock(this.#dir, {
      lockfilePath: join(this.#dir, '.lock'),
      retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
      stale: 120_000,
    });
    try { return await run(); } finally { await release(); }
  }

  async #read(): Promise<PlanSessionRecord> {
    let handle;
    try {
      handle = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 128 * 1024 ||
          (process.getuid && stat.uid !== process.getuid())) throw new PlanStreamError('unsafe_session_file');
      return parseRecord(JSON.parse(await handle.readFile('utf8')));
    } catch (error) {
      if (error instanceof PlanStreamError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PlanStreamError('sign_in_required');
      throw new PlanStreamError('session_unavailable');
    } finally { await handle?.close(); }
  }

  async #write(value: unknown, filename = this.#path) {
    const temp = join(this.#dir, `.session-${randomBytes(16).toString('hex')}.tmp`);
    let handle;
    try {
      handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, filename);
      await chmod(filename, 0o600);
      const directory = await open(this.#dir, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
    }
  }

  // For an offline authorization CLI only. Do not expose this record to HTTP.
  async install(value: PlanSessionRecord): Promise<void> {
    const parsed = parseRecord(value);
    if (!parsed.credentials.scopes.includes(SHARING_SCOPE)) throw new PlanStreamError('sharing_not_enabled');
    if (await this.#verify(parsed.credentials.idToken, parsed.clientId) !== parsed.subject) throw new PlanStreamError('account_mismatch');
    await this.#locked(async () => { await this.#write(parsed); });
  }

  async status(): Promise<{ status: 'connected' | 'reauth_required' | 'disconnected' | 'unavailable' }> {
    try {
      return await this.#locked(async () => {
        const saved = await this.#read();
        if (saved.reauthRequired || !saved.credentials.scopes.includes(SHARING_SCOPE)) return { status: 'reauth_required' };
        if (saved.pending) return { status: 'unavailable' };
        return { status: 'connected' };
      });
    } catch (error) {
      return { status: error instanceof PlanStreamError && error.code === 'sign_in_required' ? 'disconnected' : 'unavailable' };
    }
  }

  // Local CLI only. An existing registration must stay bound to its identity.
  async registration(): Promise<{ clientId: string; subject: string } | null> {
    try {
      return await this.#locked(async () => {
        const saved = await this.#read();
        return { clientId: saved.clientId, subject: saved.subject };
      });
    } catch (error) {
      if (error instanceof PlanStreamError && error.code === 'sign_in_required') {
        return this.#locked(async () => {
          let file;
          try {
            file = await open(join(this.#dir, 'registration.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
            const stat = await file.stat();
            if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096 ||
                (process.getuid && stat.uid !== process.getuid())) throw new PlanStreamError('unsafe_session_file');
            const data = JSON.parse(await file.readFile('utf8')) as { clientId?: unknown; subject?: unknown };
            if (typeof data.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(data.clientId) || data.clientId === 'dynamic_agent_client' ||
                typeof data.subject !== 'string' || !data.subject) throw new PlanStreamError('invalid_session');
            return { clientId: data.clientId, subject: data.subject };
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw err;
          } finally { await file?.close(); }
        });
      }
      throw error;
    }
  }

  async disconnect(): Promise<{ revoked: boolean }> {
    return this.#locked(async () => {
      const saved = await this.#read();
      let revoked = false;
      try {
        const result = await this.#fetch(`${ISSUER}/api/accounts/oauth/revoke`, {
          method: 'POST', signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: (saved.pending ?? saved.credentials).refreshToken,
            token_type_hint: 'refresh_token', client_id: saved.clientId,
          }),
        });
        revoked = result.status === 200;
        await result.body?.cancel().catch(() => {});
      } catch { /* clear locally even when remote revocation is unavailable */ }
      await this.#write({ clientId: saved.clientId, subject: saved.subject }, join(this.#dir, 'registration.json'));
      await unlink(this.#path);
      return { revoked };
    });
  }

  async getAuthorizedCredential(): Promise<string> {
    return this.#locked(async () => {
      const saved = await this.#read();
      if (saved.reauthRequired) throw new PlanStreamError('reauth_required');
      if (saved.pending) await this.#finishRotation(saved);
      if (!saved.credentials.scopes.includes(SHARING_SCOPE)) throw new PlanStreamError('sharing_not_enabled');
      const now = Date.now();
      if (saved.credentials.expiresAt <= now + 60_000) {
        if ((saved.credentials.earliestRefreshAt ?? 0) > now) {
          if (saved.credentials.expiresAt <= now) throw new PlanStreamError('refresh_not_ready');
        } else await this.#refresh(saved);
      }
      if (saved.credentials.expiresAt <= Date.now()) throw new PlanStreamError('reauth_required');
      return saved.credentials.accessToken;
    });
  }

  async markReauthRequired(rejectedToken: string): Promise<void> {
    await this.#locked(async () => {
      const saved = await this.#read();
      if (saved.credentials.accessToken !== rejectedToken) return;
      saved.reauthRequired = true;
      await this.#write(saved);
    });
  }

  async #finishRotation(saved: PlanSessionRecord) {
    const pending = saved.pending!;
    // An unavailable JWKS leaves the checkpoint intact for a later retry.
    if (await this.#verify(pending.idToken, saved.clientId, saved.pendingReceivedAt) !== saved.subject) {
      saved.reauthRequired = true;
      await this.#write(saved);
      throw new PlanStreamError('account_mismatch');
    }
    if (!pending.scopes.includes(SHARING_SCOPE)) {
      saved.reauthRequired = true;
      await this.#write(saved);
      throw new PlanStreamError('sharing_not_enabled');
    }
    saved.credentials = pending;
    delete saved.pending;
    delete saved.pendingReceivedAt;
    await this.#write(saved);
  }

  async #refresh(saved: PlanSessionRecord) {
    let response: Response;
    try {
      // Finish an accepted rotation even if the calling inference is aborted.
      response = await this.#fetch(TOKEN_URL, {
        method: 'POST', signal: AbortSignal.timeout(60_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: saved.clientId, refresh_token: saved.credentials.refreshToken, resource: RESOURCE }),
      });
    } catch { throw new PlanStreamError('session_network_error'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 400 || response.status === 401) {
        saved.reauthRequired = true;
        await this.#write(saved);
      }
      throw new PlanStreamError(response.status === 400 || response.status === 401 ? 'reauth_required' : 'refresh_unavailable');
    }
    let body: Record<string, unknown>;
    try { body = await response.json() as Record<string, unknown>; } catch { throw new PlanStreamError('invalid_refresh'); }
    const expires = body.expires_in;
    const scope = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : saved.credentials.scopes;
    const earliest = body.earliest_refresh_at;
    const earliestMs = typeof earliest === 'number' ? earliest * 1000 : typeof earliest === 'string' ? Date.parse(earliest) : undefined;
    if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || typeof body.id_token !== 'string' ||
        typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0) throw new PlanStreamError('invalid_refresh');
    saved.pending = credentials({
      accessToken: body.access_token, refreshToken: body.refresh_token, idToken: body.id_token,
      expiresAt: Date.now() + expires * 1000, scopes: scope,
      ...(earliestMs != null && Number.isFinite(earliestMs) ? { earliestRefreshAt: earliestMs } : {}),
    });
    saved.pendingReceivedAt = Date.now();
    // Persist the rotated token before any network-dependent identity check.
    await this.#write(saved);
    await this.#finishRotation(saved);
  }
}
