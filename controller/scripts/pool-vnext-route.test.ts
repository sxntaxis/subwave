import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set before importing the controller: never open the operator's state.
process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'pool-vnext-route-'));

test('real Pool choice uses acoustic order only with opt-in; cold and provider failure retain fallback', async () => {
  const picker = await import('../src/music/picker.js');
  const selection = await import('../src/music/pool-selection.js');
  const auditModule = await import('../src/observability/picker-audit.js');
  const library = await import('../src/music/library.js');
  const songs = Array.from({ length: 12 }, (_, i) => ({
    id: `track-${i}`, title: `Track ${i}`, artist: `Artist ${i}`, duration: 180,
  }));
  const pace = (n: number) => JSON.stringify([0, 1, 2].map(i => ({ startMs: i * 1000, endMs: (i + 1) * 1000, value: n })));
  const row = (id: string) => {
    const good = id === 'anchor' || Number(id.slice(6)) >= 8;
    return { id, track: { bpm: good ? 80 : 133, musical_key: good ? '8A' : '2B',
      pace_json: pace(good ? 0.1 : 0.9), key_ranges_json: null, duration_sec: 180 },
    vector: new Float32Array(good ? [1, 0] : [-1, 0]) };
  };
  const queue = {
    current: null, history: [], recentlyPlayed: () => ({ ids: new Set(), keys: new Set() }),
    recentArtistsSince: () => new Set(), recentAlbumKeys: () => new Set(),
    recentlyPlayedByCount: () => ({ ids: new Set(), keys: new Set() }),
    log: () => {},
  };
  let draws = 0;
  const oldRandom = Math.random;
  Math.random = () => { draws++; return 0.5; };
  const run = async (on: boolean, cold = false, fails = false) => {
    picker.clearPoolCache();
    const offered: string[][] = [];
    const events: any[] = [];
    const audit = auditModule.createPickerAuditRecorder('pool', null, null,
      { enabled: true, attemptId: 'fixture', write: event => events.push(event) });
    const observer = auditModule.bindPickerSelectionAudit(audit, on);
    const fixture = {
      build: async () => { Math.random(); return { candidates: songs.slice(), sources: {},
        strictInfo: null, playlistInfo: null }; },
      pick: async (args: any) => {
        offered.push(args.candidates.map((c: any) => c.id));
        if (fails) throw new Error('fixture provider incomplete');
        return { id: args.candidates[0].id, reason: 'fixture' };
      },
    };
    const before = draws;
    const result = await selection.withPoolAcousticReaderForTest(
      async ids => cold ? null : ids.map(row),
      () => picker.withPoolPickerFixtureForTest(fixture as any, () =>
        picker.pickViaPool(queue, { dominantMood: null, activeShow: null }, null, null, {
          ...(on ? { poolVnext: true, selection: { predecessorId: 'anchor', recentAiredIds: [] },
            selectionAudit: observer } : {}),
          onAuditCandidates: ids => audit.captureCandidates(ids),
        }, null)),
    );
    audit.finish({ outcome: 'success' });
    return { result, offered: offered[0], event: events[0], draws: draws - before };
  };
  try {
    const off = await run(false);
    const on = await run(true);
    const cold = await run(true, true);
    const fallbackOff = await run(false, false, true);
    const fallbackCold = await run(true, true, true);
    const fallbackOn = await run(true, false, true);
    assert.deepEqual(off.offered, songs.map(s => s.id));
    assert.notDeepEqual(on.offered, off.offered);
    assert.deepEqual(new Set(on.offered), new Set(off.offered));
    assert.equal(on.event.selection.scored, 1);
    assert.equal(on.event.selection.ordered_shortlists_changed, 1);
    assert.equal(JSON.stringify(on.event.selection).includes('track-'), false);
    assert.deepEqual(on.event.candidate_ids, on.offered);
    assert.deepEqual(cold.offered, off.offered);
    assert.equal(cold.event.selection.reasons.index_unavailable, 1);
    assert.equal(off.draws, on.draws);
    assert.equal(fallbackCold.result?.decisionPath, 'pool_fallback_llm_error');
    assert.equal(fallbackCold.result?.song.id, fallbackOff.result?.song.id);
    assert.equal(fallbackOn.result?.decisionPath, 'pool_fallback_llm_error');
    assert.equal(fallbackOn.result?.song.id, on.offered[0]);
    assert.equal(fallbackOn.event.selection.scored, 1);
  } finally {
    Math.random = oldRandom;
    library.shutdown();
  }
});

test('runTrackEvent reaches the same Pool path directly and after an Agent failure', async () => {
  const picker = await import('../src/music/picker.js');
  const agent = await import('../src/broadcast/dj-agent.js');
  const settings = await import('../src/settings.js');
  const runner = await import('../src/llm/internal/agent-factory.js');
  const library = await import('../src/music/library.js');
  const selection = await import('../src/music/pool-selection.js');
  const cfg = await settings.load();
  const previousAgent = cfg.llm.pickerAgent;
  const previousShows = cfg.shows;
  const previousOverride = cfg.scheduleOverride;
  const previousFlag = process.env.PICKER_VNEXT_POOL;
  const previousAgentFlag = process.env.PICKER_VNEXT_AGENT;
  cfg.shows = [{ id: 'fixture-show', name: 'Fixture' }];
  cfg.scheduleOverride = { showId: 'fixture-show', startedAt: Date.now() - 60_000, expiresAt: Date.now() + 600_000 };
  const activeShow = settings.resolveActiveShow();
  assert.equal(activeShow?.id, 'fixture-show');
  const current = { track: { id: 'anchor', title: 'Anchor', artist: 'Artist' }, startedAt: new Date().toISOString() };
  let queued = 0, agentCalls = 0, poolCalls = 0, acousticLookups = 0;
  const queue = {
    current, upcoming: [], history: [], recentlyPlayed: () => ({ ids: new Set(), keys: new Set() }),
    queuedIds: () => new Set(), recentArtistsSince: () => new Set(), recentAlbumKeys: () => new Set(),
    recentlyPlayedByCount: () => ({ ids: new Set(), keys: new Set() }),
    recentTransitionChoices: () => [], getRecentOpeners: () => [], getRecentTracks: () => [],
    getDjRecap: () => '', getLastLinkText: () => null, log: () => {},
    pushAiPick: async () => { queued++; return 1; },
  };
  const fixture = {
    build: async () => ({ candidates: [{ id: 'candidate', title: 'Track', artist: 'Other', duration: 180 }],
      sources: {}, strictInfo: null, playlistInfo: null }),
    pick: async () => { poolCalls++; return { id: 'candidate', reason: 'fixture' }; },
  };
  try {
    for (const [enabled, poolFlag, agentFlag] of [
      [false, '1', '0'], [true, '1', '1'], [false, '0', '1'], [true, '0', '0'],
    ] as const) {
      cfg.llm.pickerAgent = enabled;
      process.env.PICKER_VNEXT_POOL = poolFlag;
      process.env.PICKER_VNEXT_AGENT = agentFlag;
      await selection.withPoolAcousticReaderForTest(async ids => {
        acousticLookups++;
        return ids.map(id => ({ id, track: { bpm: 100, musical_key: '8A',
          pace_json: null, key_ranges_json: null, duration_sec: 180 }, vector: null }));
      }, () => runner.withAgentRunnerForTest((async () => {
        agentCalls++;
        throw new Error('fixture agent failure');
      }) as any, () => picker.withPoolPickerFixtureForTest(fixture as any, () =>
        agent.runTrackEvent(queue, { dominantMood: null, activeShow }, {
          wantLink: false, showAt: new Date(), target: { kind: 'current', item: current } as any,
        }))));
    }
    assert.equal(agentCalls, 2);
    assert.equal(poolCalls, 4);
    assert.equal(queued, 4);
    assert.equal(acousticLookups, 2);
  } finally {
    cfg.llm.pickerAgent = previousAgent;
    cfg.shows = previousShows;
    cfg.scheduleOverride = previousOverride;
    if (previousFlag === undefined) delete process.env.PICKER_VNEXT_POOL;
    else process.env.PICKER_VNEXT_POOL = previousFlag;
    if (previousAgentFlag === undefined) delete process.env.PICKER_VNEXT_AGENT;
    else process.env.PICKER_VNEXT_AGENT = previousAgentFlag;
    library.shutdown();
  }
});
