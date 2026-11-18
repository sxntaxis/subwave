import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanSession, type PlanSessionRecord } from '../src/llm/internal/provider/chatgpt-plan-session.js';

const base: PlanSessionRecord = {
  version: 1, clientId: 'oaiapp_fixture', subject: 'fixture-subject',
  credentials: { accessToken: 'old-token', refreshToken: 'old-refresh', idToken: 'old-id', expiresAt: 1, scopes: ['chatgpt.tokens.use.direct'] },
};

test('refresh is serialized and survives a process restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-session-'));
  let refreshes = 0;
  const verifyIdentity = async () => 'fixture-subject';
  const fetch: typeof globalThis.fetch = async () => {
    refreshes++;
    assert.ok((await lstat(join(dir, '.lock'))).isDirectory(), 'lock stays inside the private mount');
    return Response.json({ access_token: 'new-token', refresh_token: 'new-refresh', id_token: 'new-id', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' });
  };
  try {
    const one = new PlanSession(dir, { fetch, verifyIdentity });
    await one.install(base);
    const two = new PlanSession(dir, { fetch, verifyIdentity });
    const values = await Promise.all([one.getAuthorizedCredential(), two.getAuthorizedCredential()]);
    assert.deepEqual(values, ['new-token', 'new-token']);
    assert.equal(refreshes, 1);
    assert.equal(await new PlanSession(dir, { fetch, verifyIdentity }).getAuthorizedCredential(), 'new-token');
    assert.equal((await one.status()).status, 'connected');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rotation is checkpointed before identity verification and recovered without a second refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-session-'));
  let refreshes = 0;
  let canVerify = false;
  const verifyIdentity = async (token: string) => {
    if (token === 'new-id' && !canVerify) throw new Error('JWKS unavailable');
    return 'fixture-subject';
  };
  const fetch: typeof globalThis.fetch = async () => {
    refreshes++;
    return Response.json({ access_token: 'new-token', refresh_token: 'new-refresh', id_token: 'new-id', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' });
  };
  try {
    const manager = new PlanSession(dir, { fetch, verifyIdentity });
    await manager.install(base);
    await assert.rejects(manager.getAuthorizedCredential());
    assert.ok((await readFile(join(dir, 'session.json'), 'utf8')).includes('new-refresh'));
    canVerify = true;
    assert.equal(await new PlanSession(dir, { fetch, verifyIdentity }).getAuthorizedCredential(), 'new-token');
    assert.equal(refreshes, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects insecure permissions and mismatched identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-session-'));
  try {
    const session = new PlanSession(dir, { verifyIdentity: async () => 'different' });
    await assert.rejects(session.install(base), { code: 'account_mismatch' });
    await chmod(dir, 0o755);
    assert.equal((await session.status()).status, 'unavailable');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a rejected refresh stays reauth-required without repeated requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-session-'));
  let refreshes = 0;
  try {
    const session = new PlanSession(dir, {
      verifyIdentity: async () => 'fixture-subject',
      fetch: async () => { refreshes++; return new Response('', { status: 401 }); },
    });
    await session.install(base);
    await assert.rejects(session.getAuthorizedCredential(), { code: 'reauth_required' });
    await assert.rejects(session.getAuthorizedCredential(), { code: 'reauth_required' });
    assert.equal((await session.status()).status, 'reauth_required');
    assert.equal(refreshes, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('disconnect clears credentials and retains only the registration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-session-'));
  try {
    const session = new PlanSession(dir, {
      verifyIdentity: async () => 'fixture-subject',
      fetch: async () => new Response(null, { status: 200 }),
    });
    await session.install(base);
    assert.deepEqual(await session.disconnect(), { revoked: true });
    assert.equal((await session.status()).status, 'disconnected');
    assert.deepEqual(await session.registration(), { clientId: 'oaiapp_fixture', subject: 'fixture-subject' });
    const saved = await readFile(join(dir, 'registration.json'), 'utf8');
    assert.ok(!saved.includes('old-token') && !saved.includes('old-refresh'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a late unauthorized response cannot invalidate a newer session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-session-'));
  try {
    const session = new PlanSession(dir, { verifyIdentity: async () => 'fixture-subject' });
    await session.install({ ...base, credentials: { ...base.credentials, accessToken: 'new-token', expiresAt: Date.now() + 3600_000 } });
    await session.markReauthRequired('old-token');
    assert.equal((await session.status()).status, 'connected');
    await session.markReauthRequired('new-token');
    assert.equal((await session.status()).status, 'reauth_required');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
