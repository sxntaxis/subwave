import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { withAgentRunnerForTest } from '../src/llm/internal/agent-factory.js';
import {
  pickerScope, withPickerAcousticReaderForTest, withPickerSeedFixtureForTest,
} from '../src/llm/internal/tools/picker/scope.js';
import { pickerAgent, requestAgent } from '../src/broadcast/dj-agent/agents.js';
import { selectionContext } from '../src/broadcast/dj-agent/selection-context.js';
import {
  appendPickerAuditEvent, bindPickerSelectionAudit, createPickerAuditRecorder, finishAgentPickerAudit,
  type PickerAuditEvent,
} from '../src/observability/picker-audit.js';
import type { IndexedAcousticRow } from '../src/music/library-db/acoustic-index.js';

const songs = Array.from({ length: 18 }, (_, i) => ({
  id: `fixture-${i}`, title: `Fixture ${i}`, artist: `Artist ${i}`, duration: 180,
}));
const pace = (value: number) => JSON.stringify(Array.from({ length: 3 }, (_, i) =>
  ({ startMs: i * 1000, endMs: (i + 1) * 1000, value })));
const acousticRow = (id: string, preferred: boolean): IndexedAcousticRow => ({
  id,
  track: {
    bpm: preferred ? 80 : 133,
    musical_key: preferred ? '8A' : '2B',
    pace_json: pace(preferred ? 0.1 : 0.9),
    key_ranges_json: null,
    duration_sec: 180,
  },
  vector: new Float32Array(preferred ? [1, 0] : [-1, 0]),
});
const current = { track: { id: 'fixture-anchor' }, startedAt: new Date().toISOString() };
const predecessor = selectionContext(
  { kind: 'current', item: current } as any, current as any, [], [], new Date(), 'show',
  () => 'show',
)!;

async function runThroughAgent({
  request = false,
  selection = predecessor,
  observeSelection = true,
  playlist = songs,
  invokeTools = true,
  reader,
  audit,
}: {
  request?: boolean;
  selection?: typeof predecessor | null;
  observeSelection?: boolean;
  playlist?: typeof songs;
  invokeTools?: boolean;
  reader: (ids: readonly string[], timeoutMs: number) => Promise<IndexedAcousticRow[] | null>;
  audit: ReturnType<typeof createPickerAuditRecorder>;
}) {
  const selectionAudit = bindPickerSelectionAudit(audit, observeSelection);
  const scope = pickerScope({
    playlistTracks: playlist,
    ...(selection ? { selection } : {}),
    ...(selectionAudit ? { selectionAudit } : {}),
  });
  let chosenId: string | undefined;
  const runner = async ({ tools }: any) => {
    if (!invokeTools) return { object: null, steps: 1, toolCalls: [] };
    await tools.tracksThatSoundLikeThis.execute({ songId: 'fixture-anchor' }, {
      toolCallId: 'fixture-sound', messages: [],
    });
    const result = await tools.showPlaylistTracks.execute({}, {
      toolCallId: 'fixture-tool-call', messages: [],
    });
    chosenId = result[0]?.id;
    return {
      object: { id: chosenId, reason: 'fixture' },
      steps: 1,
      toolCalls: [{ name: 'tracksThatSoundLikeThis' }, { name: 'showPlaylistTracks' }],
    };
  };
  const agent = request ? requestAgent : pickerAgent;
  const oldRandom = Math.random;
  let draw = 0;
  Math.random = () => 1 - (draw++ / 100);
  let result;
  try {
    result = await withPickerSeedFixtureForTest(
      { audio: true, text: true, lookup: () => [] },
      () => withPickerAcousticReaderForTest(reader, () =>
        withAgentRunnerForTest(runner as any, () => agent.run({ messages: [], scope } as any))),
    );
  } finally {
    Math.random = oldRandom;
  }
  return {
    chosenId,
    candidateIds: [...(result.extras?.seen?.keys?.() ?? [])],
    toolCalls: result.toolCalls ?? [],
  };
}

async function persistedAttempt(
  directory: string,
  attemptId: string,
  run: (audit: ReturnType<typeof createPickerAuditRecorder>) => Promise<void>,
) {
  let write: Promise<void> = Promise.resolve();
  const audit = createPickerAuditRecorder('agent', null, null, {
    enabled: true,
    attemptId,
    write(event: PickerAuditEvent) {
      write = appendPickerAuditEvent(event, directory);
    },
  });
  await run(audit);
  await write;
  const files = (await import('node:fs/promises')).readdir;
  const names = await files(directory);
  const rows = (await readFile(resolve(directory, names[0]), 'utf8')).trim().split('\n');
  return JSON.parse(rows[rows.length - 1]) as PickerAuditEvent;
}

test('real Agent tool construction persists scored and baseline outcomes privately', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'picker-audit-e2e-'));
  try {
    const scored = await persistedAttempt(directory, 'scored-attempt', async audit => {
      const result = await runThroughAgent({
        audit,
        reader: async ids => ids.map(id =>
          acousticRow(id, id === 'fixture-anchor' || Number(id.slice('fixture-'.length)) >= 12)),
      });
      assert.ok(result.chosenId);
      finishAgentPickerAudit(audit, {
        ...result, outcome: 'success', chosenId: result.chosenId,
      });
    });
    assert.equal(scored.path, 'agent');
    assert.equal(scored.outcome, 'success');
    assert.equal(scored.selection?.status, 'observed');
    assert.equal(scored.selection?.scored, 1);
    assert.equal(scored.selection?.baseline, 0);
    assert.equal(scored.selection?.reasons.scored_membership_change, 1);
    assert.equal(scored.acoustic_search_tool_calls, 1);
    assert.equal(scored.selection?.eligible_candidates, 18);
    assert.ok((scored.selection?.lookup_ms ?? 0) >= 0);

    const fallback = await persistedAttempt(directory, 'fallback-attempt', async audit => {
      const result = await runThroughAgent({
        audit,
        reader: async () => null,
      });
      assert.ok(result.chosenId);
      finishAgentPickerAudit(audit, {
        ...result, outcome: 'success', chosenId: result.chosenId,
      });
    });
    assert.equal(fallback.selection?.status, 'observed');
    assert.equal(fallback.selection?.scored, 0);
    assert.equal(fallback.selection?.baseline, 1);
    assert.equal(fallback.selection?.reasons.index_unavailable, 1);
    assert.equal(fallback.acoustic_search_tool_calls, 1);
    assert.notEqual(fallback.selection?.reasons.scored_membership_change, 1);

    const missingPredecessor = await persistedAttempt(directory, 'no-anchor-attempt', async audit => {
      const result = await runThroughAgent({
        audit, selection: null, reader: async () => { throw new Error('must not query'); },
      });
      assert.ok(result.chosenId);
      finishAgentPickerAudit(audit, {
        ...result, outcome: 'success', chosenId: result.chosenId,
      });
    });
    assert.equal(missingPredecessor.selection?.reasons.no_eligible_context, 2);
    assert.equal(missingPredecessor.acoustic_search_tool_calls, 1);

    const unchanged = await persistedAttempt(directory, 'unchanged-attempt', async audit => {
      const result = await runThroughAgent({
        audit, playlist: songs.slice(0, 12),
        reader: async ids => ids.map(id => acousticRow(id, true)),
      });
      finishAgentPickerAudit(audit, { ...result, outcome: 'success' });
    });
    assert.equal(unchanged.selection?.status, 'observed');
    assert.equal(unchanged.selection?.scored, 1);
    assert.equal(unchanged.selection?.reasons.scored_no_membership_change, 1);

    const timeout = await persistedAttempt(directory, 'timeout-attempt', async audit => {
      const result = await runThroughAgent({
        audit, reader: async () => new Promise(() => {}),
      });
      finishAgentPickerAudit(audit, { ...result, outcome: 'success' });
    });
    assert.equal(timeout.selection?.status, 'observed');
    assert.equal(timeout.selection?.baseline, 1);
    assert.equal(timeout.selection?.reasons.deadline_or_budget, 1);

    const noTool = await persistedAttempt(directory, 'no-tool-attempt', async audit => {
      const result = await runThroughAgent({
        audit, invokeTools: false, reader: async () => { throw new Error('unexpected'); },
      });
      finishAgentPickerAudit(audit, { ...result, outcome: 'empty' });
    });
    assert.deepEqual(noTool.selection, {
      status: 'not_invoked', reasons: { collector_not_invoked: 1 },
    });
    assert.equal(noTool.acoustic_search_tool_calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('request Agent clears autonomous scoring observation; OFF path does not look up acoustics', async () => {
  let lookups = 0;
  let observations = 0;
  const requestAudit = createPickerAuditRecorder('agent', null, null, {
    enabled: true, attemptId: 'request-attempt', write: () => { observations++; },
  });
  const requestChoice = await runThroughAgent({
    request: true,
    audit: requestAudit,
    reader: async () => { lookups++; return null; },
  });
  assert.ok(requestChoice.chosenId);
  assert.equal(lookups, 0);
  assert.equal(observations, 0);

  const offAudit = createPickerAuditRecorder('agent', null, null, {
    enabled: false, attemptId: 'off-attempt', write: () => { observations++; },
  });
  const offChoice = await runThroughAgent({
    audit: offAudit, selection: null, observeSelection: false,
    reader: async () => { lookups++; return null; },
  });
  assert.ok(offChoice.chosenId);
  assert.equal(lookups, 0);
  assert.equal(observations, 0);
});
