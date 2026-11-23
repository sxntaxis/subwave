import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requestBudgetMs, requestPhaseMs, requireRequestPhaseMs,
  REQUEST_AGENT_RUN_MAX_MS, REQUEST_BUDGET_BASE_MS, REQUEST_BUDGET_MAX_MS,
  REQUEST_FIRST_PASS_RESERVE_MS,
} from '../src/broadcast/dj-agent/request-budget.ts';

test('requests get queue-aware thinking time, never the autonomous 100s timeout', () => {
  assert.equal(requestBudgetMs(0), 300_000);
  assert.equal(requestBudgetMs(1), 360_000);
  assert.equal(requestBudgetMs(2), 420_000);
  assert.equal(requestBudgetMs(3), 480_000);
  assert.equal(requestBudgetMs(100), REQUEST_BUDGET_MAX_MS);
  assert.equal(requestBudgetMs(NaN), REQUEST_BUDGET_BASE_MS);
  assert.equal(requestBudgetMs(-5), REQUEST_BUDGET_BASE_MS);
});

test('first pass reserves runway for lyric retrieval and interpretation', () => {
  const start = 10_000;
  const deadline = start + requestBudgetMs(0);
  assert.equal(requestPhaseMs(deadline, REQUEST_AGENT_RUN_MAX_MS,
    REQUEST_FIRST_PASS_RESERVE_MS, start), 210_000);
  assert.equal(requestPhaseMs(deadline, REQUEST_AGENT_RUN_MAX_MS,
    REQUEST_FIRST_PASS_RESERVE_MS, start + 180_000), 30_000);
});

test('second and subsequent runs draw down the SAME absolute deadline', () => {
  const start = 20_000;
  const deadline = start + requestBudgetMs(2);
  assert.equal(requestPhaseMs(deadline, REQUEST_AGENT_RUN_MAX_MS, 90_000, start), 300_000);
  assert.equal(requestPhaseMs(deadline, REQUEST_AGENT_RUN_MAX_MS, 0, start + 300_000), 120_000);
  assert.equal(requestPhaseMs(deadline, REQUEST_AGENT_RUN_MAX_MS, 0, start + 419_999), 1);
  assert.equal(requestPhaseMs(deadline, REQUEST_AGENT_RUN_MAX_MS, 0, start + 420_000), 0);
});

test('an exhausted deadline throws instead of disabling the SDK timeout with zero', () => {
  const deadline = 123_000;
  assert.throws(() => requireRequestPhaseMs(deadline, 30_000, 0, deadline),
    (err: any) => err.name === 'AgentDeadlineError');
  assert.throws(() => requireRequestPhaseMs(deadline, 30_000, 5_000, deadline - 4_000),
    /shared work budget exhausted/);
});

test('the auxiliary cap cannot exceed the remaining request budget', () => {
  assert.equal(requestPhaseMs(101_000, 90_000, 0, 100_000), 1_000);
  assert.equal(requestPhaseMs(101_000, 90_000, 0, 90_000), 11_000);
  assert.equal(requestPhaseMs(101_000, 90_000, 0, 50_000), 51_000);
});
