import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-coyote-ipc-'));
const socketPath = join(root, 'coyote.sock');
process.env.COYOTE_SOCKET_PATH = socketPath;
process.env.COYOTE_TIMEOUT_MS = '1000';
const coyote = await import('../src/coyote/client.js');

async function withServer(
  reply: (request: Record<string, unknown>) => Record<string, unknown>,
  run: () => Promise<void>,
): Promise<void> {
  const server = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      const newline = data.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(data.slice(0, newline)) as Record<string, unknown>;
      socket.end(`${JSON.stringify(reply(request))}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    await run();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Coyote IPC sends the versioned single-line contract', async () => {
  await withServer((request) => {
    assert.equal(request.version, 1);
    assert.equal(request.op, 'mood.read');
    assert.equal((request.track as { navidromeId?: string }).navidromeId, 'nav-1');
    return {
      ok: true,
      version: 1,
      requestId: request.requestId,
      result: { coyoteTrackId: 'coyote-1', path: '/music/a.flac', moods: ['Warm'] },
    };
  }, async () => {
    const result = await coyote.readMood({ navidromeId: 'nav-1', pathHint: 'Artist/Album/a.flac' });
    assert.deepEqual(result.moods, ['Warm']);
  });
});

test('Coyote IPC surfaces backend errors without changing their code', async () => {
  await withServer((request) => ({
    ok: false,
    version: 1,
    requestId: request.requestId,
    error: { code: 'IDENTITY_AMBIGUOUS', message: 'ambiguous' },
  }), async () => {
    await assert.rejects(
      () => coyote.manualSetMoods([{ navidromeId: 'nav-1' }], ['Dark']),
      (error: unknown) => error instanceof coyote.CoyoteError && error.code === 'IDENTITY_AMBIGUOUS',
    );
  });
});

test('locator carries Navidrome identity hints but no file-system authority', () => {
  assert.deepEqual(coyote.locatorFromSong({
    id: 'nav-2',
    path: 'Artist/Album/01 - Track.flac',
    musicBrainzId: 'mbid-1',
    title: 'Track', artist: 'Artist', album: 'Album', duration: 123,
  }), {
    navidromeId: 'nav-2',
    pathHint: 'Artist/Album/01 - Track.flac',
    recordingMbid: 'mbid-1',
    title: 'Track', artist: 'Artist', album: 'Album', duration: 123,
  });
});

process.on('exit', () => rmSync(root, { recursive: true, force: true }));
