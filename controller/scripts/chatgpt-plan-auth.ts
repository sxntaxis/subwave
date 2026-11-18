// Local-only SIWC authorization. Run on the machine with the browser; never
// publish this callback or put credentials in the admin UI or settings.json.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { generateText } from 'ai';
import { PlanSession, type PlanSessionRecord } from '../src/llm/internal/provider/chatgpt-plan-session.js';
import { createPlanModel } from '../src/llm/internal/provider/chatgpt-plan-model.js';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const random = () => randomBytes(32).toString('base64url');
const directory = process.argv[3] || '';
const command = process.argv[2] || '';

async function hostId(): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Credential directory must be owned by this user and have mode 0700.');
  }
  const path = join(directory, 'host-id');
  try {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(`urn:uuid:${randomUUID()}\n`); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe host-id file.');
  const value = (await readFile(path, 'utf8')).trim();
  if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid host identifier.');
  return value;
}

async function connect(session: PlanSession) {
  const host = await hostId();
  const previous = await session.registration();
  const state = random();
  const nonce = random();
  const verifier = random();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let port = 0;
  let finish!: (url: URL) => void;
  const callback = new Promise<URL>(resolve => { finish = resolve; });
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
    const supplied = url.searchParams.get('state') || '';
    if (supplied.length !== state.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(state))) { res.writeHead(400).end('Invalid sign-in state.'); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('You may return to the terminal.');
    finish(url);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); });
  });
  try {
    const redirect = `http://127.0.0.1:${port}/auth/callback`;
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    for (const [key, value] of Object.entries({
      client_id: previous?.clientId || 'dynamic_agent_client',
      ...(!previous ? { agent_name_hint: 'SUB/WAVE' } : {}), ext_agent_host_id: host,
      response_type: 'code', redirect_uri: redirect,
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: challenge,
    })) url.searchParams.set(key, value);
    console.log(`Open this official URL and approve ChatGPT plan use:\n${url}`);
    const timeout = AbortSignal.timeout(10 * 60_000);
    const result = await Promise.race([callback, new Promise<never>((_, reject) => timeout.addEventListener('abort', () => reject(new Error('Sign-in timed out.')), { once: true }))]);
    if (result.searchParams.get('error')) throw new Error('Sign-in was declined or failed.');
    const code = result.searchParams.get('code');
    const returnedId = result.searchParams.get('client_id');
    if (previous && returnedId && returnedId !== previous.clientId) throw new Error('Unexpected registration returned.');
    const clientId = returnedId || previous?.clientId;
    if (!code || !clientId || !/^[A-Za-z0-9_-]{1,200}$/.test(clientId) || clientId === 'dynamic_agent_client') throw new Error('Sign-in registration was incomplete.');
    const response = await fetch(`${ISSUER}/api/accounts/oauth/token`, {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Token exchange failed (HTTP ${response.status}).`); }
    const token = await response.json() as Record<string, unknown>;
    if (typeof token.id_token !== 'string' || typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string' ||
        typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || typeof token.scope !== 'string') throw new Error('Token exchange returned an invalid session.');
    const verified = await jwtVerify(token.id_token, createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`)), {
      issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub'],
    });
    if (verified.payload.nonce !== nonce || !verified.payload.sub) throw new Error('Identity validation failed.');
    if (previous && verified.payload.sub !== previous.subject) throw new Error('The selected account differs from the existing registration.');
    const scopes = token.scope.split(/\s+/).filter(Boolean);
    if (!scopes.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan permission was not granted.');
    const earliest = token.earliest_refresh_at;
    const earliestMs = typeof earliest === 'number' ? earliest * 1000 : typeof earliest === 'string' ? Date.parse(earliest) : undefined;
    const record: PlanSessionRecord = {
      version: 1, clientId, subject: verified.payload.sub,
      credentials: {
        accessToken: token.access_token, refreshToken: token.refresh_token, idToken: token.id_token,
        expiresAt: Date.now() + token.expires_in * 1000, scopes,
        ...(earliestMs != null && Number.isFinite(earliestMs) ? { earliestRefreshAt: earliestMs } : {}),
      },
    };
    await session.install(record);
    console.log("You're using your ChatGPT plan for eligible requests. Manage limits and credits at https://chatgpt.com/settings/usage");
    console.log('ChatGPT plan connected. Credentials are stored in the protected directory.');
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function main() {
  if (!isAbsolute(directory) || !['connect', 'status', 'disconnect', 'models', 'probe', 'activate', 'retry'].includes(command)) {
    throw new Error('Usage: tsx scripts/chatgpt-plan-auth.ts <connect|status|disconnect|models|probe|activate|retry> </absolute/private/directory> [model]');
  }
  const session = new PlanSession(directory);
  if (command === 'connect') await connect(session);
  else if (command === 'status') {
    const state = await session.status();
    console.log(`ChatGPT plan: ${state.status}${state.error ? ` (${state.error})` : ''}`);
  }
  else if (command === 'retry') {
    await session.retryRequests();
    console.log('ChatGPT plan refusal cleared; the next request will retry.');
  }
  else if (command === 'disconnect') {
    const result = await session.disconnect();
    console.log(result.revoked ? 'Disconnected and revoked.' : 'Disconnected locally; remote revocation was not confirmed. Disconnect the app in ChatGPT Settings.');
  } else if (command === 'models') {
    const token = await session.getAuthorizedCredential();
    const response = await fetch(`${RESOURCE}/models`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Model discovery failed (HTTP ${response.status}).`); }
    const data = await response.json() as { models?: { slug?: unknown; visibility?: unknown }[] };
    if (!Array.isArray(data.models)) throw new Error('Model discovery returned an invalid response.');
    for (const model of data.models) if (model.visibility === 'list' && typeof model.slug === 'string') console.log(model.slug);
  } else if (command === 'probe') {
    const modelId = process.argv[4] || '';
    if (!modelId || modelId.length > 100) throw new Error('Provide an account-available model ID.');
    const model = createPlanModel(modelId, () => session.getAuthorizedCredential(), fetch, token => session.markReauthRequired(token), (token, reason) => session.blockRequests(token, reason));
    const result = await generateText({ model, prompt: 'Reply with the word OK.', maxRetries: 0, abortSignal: AbortSignal.timeout(45_000) });
    if (!result.text.trim()) throw new Error('The model returned an empty response.');
    console.log(`ChatGPT plan model ${modelId}: response completed.`);
  } else {
    const modelId = process.argv[4] || '';
    const user = process.env.ADMIN_USER;
    const pass = process.env.ADMIN_PASS;
    if (!modelId || modelId.length > 100) throw new Error('Provide an account-available model ID.');
    if (!user || !pass) throw new Error('Run inside the controller with ADMIN_USER and ADMIN_PASS available.');
    const port = Number(process.env.PORT || 7701);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid controller port.');
    const response = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: { provider: 'chatgpt-plan', model: modelId } }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Settings update failed (HTTP ${response.status}).`); }
    await response.body?.cancel();
    console.log(`ChatGPT plan selected: ${modelId}.`);
  }
}

main().catch(error => {
  console.error(`ChatGPT plan operation failed: ${error instanceof Error && error.name === 'Error' ? error.message : 'authorization or storage error'}`);
  process.exitCode = 1;
});
