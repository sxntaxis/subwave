import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { appendPickerAuditEvent, createPickerAuditRecorder, type PickerAuditEvent } from '../src/observability/picker-audit.js';

const NOW = () => new Date('2026-11-18T12:34:56.000Z');

test('off mode performs no candidate capture or write', () => {
  const events: PickerAuditEvent[] = [];
  const audit = createPickerAuditRecorder('pool', 'show-fixture', null, {
    enabled: false, attemptId: 'trace-fixture', now: NOW, write: event => events.push(event),
  });
  audit.captureCandidates(['one', 'two']);
  audit.finish({ outcome: 'success', chosenId: 'one' });
  assert.deepEqual(events, []);
});

test('agent, pool and auto refresh retain ordered unique IDs and safe outcome fields', () => {
  for (const path of ['agent', 'pool', 'auto_refresh'] as const) {
    const events: PickerAuditEvent[] = [];
    const audit = createPickerAuditRecorder(path, null, new Date('2026-11-18T12:00:00.000Z'), {
      enabled: true, attemptId: 'trace-fixture', now: NOW, write: event => events.push(event),
    });
    audit.setShowId('show-fixture');
    audit.captureCandidates(['one', null, 'two', 'one', undefined]);
    audit.finish({ outcome: 'repaired', chosenId: 'two', toolCalls: 3 });
    audit.finish({ outcome: 'error', fallbackReason: 'must_not_replace_first_record' });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      schema_version: 1,
      timestamp: '2026-11-18T12:34:56.000Z',
      attempt_id: 'trace-fixture',
      path,
      show_id: 'show-fixture',
      show_at: '2026-11-18T12:00:00.000Z',
      candidate_ids: ['one', 'two'],
      chosen_id: 'two',
      outcome: 'repaired',
      tool_calls: 3,
    });
  }
});

test('each selector path records a bounded terminal outcome, including failures', () => {
  for (const path of ['agent', 'pool', 'auto_refresh'] as const) {
    for (const outcome of ['success', 'error'] as const) {
      const events: PickerAuditEvent[] = [];
      const audit = createPickerAuditRecorder(path, 'show-fixture', null, {
        enabled: true, attemptId: `trace-${path}`, now: NOW, write: event => events.push(event),
      });
      audit.captureCandidates(outcome === 'error' ? [] : ['fixture-a']);
      audit.finish({ outcome, fallbackPath: outcome === 'error' ? (path === 'auto_refresh' ? 'auto_playlist' : 'pool') : null });
      assert.equal(events.length, 1);
      assert.equal(events[0].path, path);
      assert.equal(events[0].outcome, outcome);
      assert.deepEqual(events[0].candidate_ids, outcome === 'error' ? [] : ['fixture-a']);
    }
  }
});

test('writer failures are swallowed and do not mutate selection results', () => {
  const chosen = 'fixture-choice';
  const audit = createPickerAuditRecorder('pool', null, null, {
    enabled: true, attemptId: null, now: NOW, write: () => { throw new Error('disk unavailable'); },
  });
  audit.captureCandidates(['fixture-choice', 'fixture-other']);
  assert.doesNotThrow(() => audit.finish({ outcome: 'success', chosenId: chosen }));
  assert.equal(chosen, 'fixture-choice');
});

test('private file writer requires an owner-only directory and creates owner-only JSONL', async () => {
  const parent = await mkdtemp(resolve(tmpdir(), 'picker-audit-test-'));
  const safe = resolve(parent, 'safe');
  const unsafe = resolve(parent, 'unsafe');
  await Promise.all([mkdir(safe, { mode: 0o700 }), mkdir(unsafe, { mode: 0o755 })]);
  try {
    const event: PickerAuditEvent = {
      schema_version: 1,
      timestamp: '2026-11-18T12:34:56.000Z',
      attempt_id: 'trace-fixture',
      path: 'pool',
      show_id: 'show-fixture',
      show_at: null,
      candidate_ids: ['fixture-a'],
      chosen_id: 'fixture-a',
      outcome: 'success',
    };
    await appendPickerAuditEvent(event, safe);
    const file = resolve(safe, 'offers-2026-11-18.jsonl');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse((await readFile(file, 'utf8')).trim()), event);
    await appendPickerAuditEvent(event, unsafe);
    await assert.rejects(stat(resolve(unsafe, 'offers-2026-11-18.jsonl')), { code: 'ENOENT' });
  } finally {
    await chmod(parent, 0o700);
    await rm(parent, { recursive: true, force: true });
  }
});

test('audit-enabled fixture preserves seeded choice, offered order, calls and state', () => {
  const fixture = (enabled: boolean) => {
    let seed = 0x12345678;
    const next = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const state = { calls: 0, queue: ['already-queued'], candidates: ['a', 'b', 'c', 'd'] };
    const offered = [...state.candidates].sort(() => next() - 0.5);
    const audit = createPickerAuditRecorder('pool', null, null, {
      enabled, attemptId: 'fixture', now: NOW, write: () => {},
    });
    audit.captureCandidates(offered);
    state.calls++;
    const chosen = offered[Math.floor(next() * offered.length)];
    state.queue.push(chosen);
    audit.finish({ outcome: 'success', chosenId: chosen });
    return { state, offered, chosen, seed };
  };
  assert.deepEqual(fixture(false), fixture(true));
});

test('source wiring observes existing boundaries without adding model or search calls', async () => {
  const root = resolve(import.meta.dirname, '..');
  const [scope, agent, pool, scheduler] = await Promise.all([
    readFile(resolve(root, 'src/llm/internal/tools/picker/scope.ts'), 'utf8'),
    readFile(resolve(root, 'src/broadcast/dj-agent.ts'), 'utf8'),
    readFile(resolve(root, 'src/music/picker.ts'), 'utf8'),
    readFile(resolve(root, 'src/broadcast/scheduler.ts'), 'utf8'),
  ]);
  assert.match(scope, /const seen = scope\.seen \?\? new Map/);
  assert.match(agent, /seen: auditSeen/);
  assert.match(agent, /audit\.captureCandidates\(extras\.seen\.keys\(\)\)/);
  assert.match(agent, /audit\.finish\(\{ outcome: 'error', fallbackPath: 'pool'/);
  assert.match(pool, /onAuditCandidates\?\.\(candidates\.map\(\(c\) => c\?\.id\)\)/);
  assert.match(pool, /CANDIDATE_CAP = 18/);
  assert.match(scheduler, /TARGET_POOL = 40/);
  assert.match(scheduler, /audit\?\.captureCandidates\(pool\.map\(\(t: any\) => t\?\.id\)\)/);
  assert.doesNotMatch(agent, /logEvent\(['"]pick\.audit/);
});

test('fallback and collision outcomes remain distinct from independent attempt IDs', () => {
  const events: PickerAuditEvent[] = [];
  for (const [outcome, fallbackPath] of [['fallback', 'pool'], ['collision', undefined]] as const) {
    const audit = createPickerAuditRecorder('agent', null, null, {
      enabled: true, attemptId: 'shared-track-trace', now: NOW, write: event => events.push(event),
    });
    audit.captureCandidates(['fixture']);
    audit.finish({ outcome, ...(fallbackPath ? { fallbackPath } : {}) });
  }
  assert.deepEqual(events.map(event => [event.attempt_id, event.path, event.outcome]), [
    ['shared-track-trace', 'agent', 'fallback'],
    ['shared-track-trace', 'agent', 'collision'],
  ]);
});
