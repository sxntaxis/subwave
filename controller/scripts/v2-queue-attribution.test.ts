import assert from 'node:assert/strict';
import test from 'node:test';
import { exactV2StartToken, queueItemForPersistence } from '../src/broadcast/queue/v2-attribution.js';
import type { QueueItem } from '../src/broadcast/queue/types.js';

process.env.SUBWAVE_PICKER_AUDIT = '1';

const tokenA = 'a'.repeat(32);
const tokenB = 'b'.repeat(32);
const row = (queueToken: string, overrides: Partial<QueueItem> = {}): QueueItem => ({
  track: { id: 'same-song', title: 'Same', artist: 'Artist' },
  queueToken, aiPicked: true, sent: true, ...overrides,
});
const marker = (queueToken?: string, extra = {}) => ({
  title: 'Same', artist: 'Artist', subsonic_id: 'same-song',
  timestamp: 1_800_000_000, ...(queueToken ? { subwave_queue_token: queueToken } : {}), ...extra,
});

test('only the exact fresh sent Agent insertion token is eligible for start attribution', () => {
  const now = 1_800_000_000_000;
  const a = row(tokenA), b = row(tokenB);
  assert.equal(exactV2StartToken(marker(tokenA), null, [b, a], now), tokenA);
  assert.equal(exactV2StartToken(marker(), null, [a], now), null);
  assert.equal(exactV2StartToken(marker('c'.repeat(32)), null, [a], now), null);
  assert.equal(exactV2StartToken(marker(tokenA, { subwave_clip: true }), null, [a], now), null);
  assert.equal(exactV2StartToken(marker(tokenA), null, [row(tokenA, { sent: false })], now), null);
  assert.equal(exactV2StartToken(marker(tokenA), null, [row(tokenA, { aiPicked: false })], now), null);
  assert.equal(exactV2StartToken(marker(tokenA), row(tokenB), [], now), null);
  assert.equal(exactV2StartToken(marker(tokenA), row(tokenA), [], now), tokenA);
  assert.equal(exactV2StartToken(marker(tokenA, { timestamp: 1 }), row(tokenA), [], now), null);
});

test('queue persistence drops insertion tokens without mutating the live item', () => {
  const item = row(tokenA);
  const persisted = queueItemForPersistence(item);
  assert.equal('queueToken' in persisted, false);
  assert.equal(item.queueToken, tokenA);
  assert.equal(JSON.stringify(persisted).includes(tokenA), false);
});

test('restart recovery and cancellation leave old markers unattributed', () => {
  const now = 1_800_000_000_000;
  const markerWithOldToken = marker(tokenA);
  const recovered = JSON.parse(JSON.stringify(queueItemForPersistence(row(tokenA))));
  assert.equal(exactV2StartToken(markerWithOldToken, recovered, [], now), null,
    'a persisted/recovered row cannot restore its process-local correlation');
  assert.equal(exactV2StartToken(markerWithOldToken, null, [], now), null,
    'a cancelled/removed row cannot attribute even if its marker arrives late');
});

test('real queue insertion receipts are unique and duplicate rejection has no receipt', async () => {
  const { queue } = await import('../src/broadcast/queue.js');
  queue.current = null;
  queue.upcoming = [];
  queue.persist = () => {};
  queue.drainToLiquidsoap = async () => {};
  queue.log = () => {};
  queue.warnIfSwallowedByCrossfade = () => {};
  const receipts: Array<{ token: string; item: QueueItem }> = [];
  const args = { track: { id: 'same-id', title: 'Same', artist: 'Artist' }, aiPicked: true };
  assert.equal(await queue.push(args, receipt => receipts.push(receipt)), 1);
  assert.equal(await queue.push({ ...args, allowDuplicate: true }, receipt => receipts.push(receipt)), 2);
  assert.equal(receipts.length, 2);
  assert.notEqual(receipts[0].token, receipts[1].token);
  assert.equal(receipts[0].item, queue.upcoming[0]);
  assert.equal(receipts[1].item, queue.upcoming[1]);
  assert.equal(await queue.push(args, () => assert.fail('duplicate must not receive accepted receipt')), -1);
  assert.equal(receipts.length, 2);
});

test('clip metadata does not attribute; matching real marker after legacy dedup attributes once', async () => {
  const [{ queue }, auditModule] = await Promise.all([
    import('../src/broadcast/queue.js'),
    import('../src/observability/picker-audit.js'),
  ]);
  queue.current = null;
  queue.history = [];
  queue.upcoming = [];
  queue.lastSeenKey = '';
  queue.autoPick = false;
  queue.persist = () => {};
  queue.drainToLiquidsoap = async () => {};
  queue.log = () => {};
  queue.warnIfSwallowedByCrossfade = () => {};
  queue.airIntro = async () => {};
  const auditEvents: any[] = [];
  const audit = auditModule.createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: `attempt-${Date.now()}`, write: event => auditEvents.push(event),
  });
  audit.noteV2Joint(false);
  audit.captureV2JointCandidates(['same-song']);
  assert.equal(audit.captureV2Selection('same-song'), true);
  let receipt!: { token: string; item: QueueItem };
  await queue.push({ track: { id: 'same-song', title: 'Same', artist: 'Artist' }, aiPicked: true },
    value => { receipt = value; });
  receipt.item.sent = true;
  audit.recordV2Enqueued(receipt.token);
  const markerBase = { title: 'Same', artist: 'Artist', album: '', subsonic_id: 'same-song', timestamp: Date.now() / 1000 };
  queue.onTrackStarted({ ...markerBase, subwave_clip: true });
  assert.equal(queue.current?.queueToken, receipt.token);
  assert.equal(exactV2StartToken({ ...markerBase, subwave_clip: true }, queue.current, []), null);
  const starts = queue._trackStarts;
  const history = queue.history.length;
  queue.onTrackStarted({ ...markerBase, subwave_queue_token: receipt.token });
  assert.equal(queue._trackStarts, starts, 'duplicate-key real marker does not rotate queue state twice');
  assert.equal(queue.history.length, history);
  assert.equal(auditModule.observeV2QueueStart(receipt.token, () => {}, true), false,
    'the real marker consumed the exact accepted token once');
  assert.equal(auditEvents.some(event => event.stage === 'selected' && event.v2_joint_offered), true);
  assert.equal(auditEvents.some(event => event.event_type === 'v2_lifecycle' && event.stage === 'enqueued'), true);
  assert.equal(JSON.stringify(queue.snapshot()).includes(receipt.token), false);
  assert.equal(JSON.stringify(await queue.getNowPlaying()).includes(receipt.token), false);
});
