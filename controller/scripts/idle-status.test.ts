import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'node:net';

let reply: string | null = 'on';
const server = createServer(socket => socket.once('data', () => {
  socket.end(reply == null ? '' : `${reply}\r\nEND\r\n`);
}));
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = String(address.port);
const { idleStatus } = await import('../src/broadcast/liquidsoap-control.js');
after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

test('only an explicit mixer reply confirms the idle gate state', async () => {
  reply = 'on';
  assert.equal(await idleStatus(), true);
  reply = 'off';
  assert.equal(await idleStatus(), false);
  reply = null;
  await assert.rejects(idleStatus(), /not confirmed/);
  reply = 'unrecognized command';
  await assert.rejects(idleStatus(), /not confirmed/);
});
