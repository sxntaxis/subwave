import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachCompleteMusicEvidence, completeDiscoveryMusicEvidence, sampledWindowEvidence,
} from '../src/music/music-evidence-profile.js';
import type { MusicEvidenceV2, ModelOutput } from '../src/music/musical-evidence-v2.js';
import compareMusicalCandidates from '../src/llm/internal/tools/picker/tools/compare-musical-candidates.js';
import { lookupMusicEvidenceSocketResult, withEssentiaReaderForTest } from '../src/music/essentia-evidence.js';
import { buildPickerContext, pickerScope } from '../src/llm/internal/tools/picker/scope.js';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEAM = 'DEAM native [1,9], valence then arousal';
const NATIVE = 'model native; see metadata';
const outputs = (modelId: string, label: string, value: number | null,
  validity = 'valid'): ModelOutput => ({
  modelId, label, value, validity,
  nativeScale: modelId === 'deam-msd-musicnn-2' ? DEAM : NATIVE,
  missingReason: null,
});
function sample(id: string, partial = false): MusicEvidenceV2 {
  const one = (arousal: number, withPiano: boolean) => [
    outputs('deam-msd-musicnn-2', 'arousal', arousal),
    outputs('deam-msd-musicnn-2', 'valence', 4),
    outputs('danceability-discogs-effnet-1', 'danceable', 0.4),
    outputs('voice_instrumental-discogs-effnet-1', 'voice', 0.3),
    outputs('timbre-discogs-effnet-1', 'bright', 0.5),
    ...Array.from({ length: 12 }, (_, i) => outputs('mtg_jamendo_instrument-discogs-effnet-1',
      `instrument${i}`, .99 - i * .02)),
    ...Array.from({ length: 12 }, (_, i) => outputs('mtg_jamendo_moodtheme-discogs-effnet-1',
      `mood${i}`, .98 - i * .02)),
    ...(withPiano ? [outputs('mtg_jamendo_instrument-discogs-effnet-1', 'piano', .8)] : []),
  ];
  return {
    trackId: id, analysisId: `secret-analysis-${id}`, runId: 'private-run',
    modelsHash: 'a'.repeat(64), sourceSize: '1000', sourceMtimeNs: '1700000000000000000',
    expectedWindows: 2,
    windows: [
      { startMs: 0, endMs: 10000, role: 'opening', outputs: one(3, true) },
      { startMs: 200000, endMs: 210000, role: 'ending', outputs: one(6, !partial) },
    ],
  };
}

test('v2.2 preserves every valid label and describes partial labels honestly without identifiers', () => {
  const evidence = sample('synthetic', true);
  const before = JSON.stringify(evidence);
  const profile = completeDiscoveryMusicEvidence(evidence);
  assert.equal(profile.instruments.scores.length, 13);
  assert.equal(profile.moodThemes.scores.length, 12);
  const partial = profile.instruments.scores.find(row => row.label === 'piano');
  assert.equal(partial?.coverage, 'partial');
  assert.equal(partial?.validWindows, 1);
  assert.equal(partial?.expectedWindows, 2);
  assert.equal(profile.detail, 'verified_discovery');
  for (const key of ['secret-analysis', 'private-run', 'modelsHash', 'sourceSize', 'sourceMtimeNs']) {
    assert.ok(!JSON.stringify(profile).includes(key));
  }
  assert.equal(JSON.stringify(evidence), before);
  const windows = sampledWindowEvidence(evidence, ['instrument'], { includeAllVerifiedLabels: true });
  const instrument = windows.features.instrument as { availableLabels: number; returnedLabels: number };
  assert.equal(instrument.availableLabels, 13);
  assert.equal(instrument.returnedLabels, 13);
});

test('v2.2 attaches 12 complete verified profiles with no 8KiB share and no input mutation', () => {
  const tracks = Array.from({ length: 12 }, (_, i) => ({ id: `song-${i}`, title: `Fixture ${i}` }));
  const rows = new Map(tracks.map(track => [track.id, sample(track.id)]));
  const before = JSON.stringify(tracks);
  const enriched = attachCompleteMusicEvidence(tracks, rows);
  assert.equal(enriched.filter(track => 'musical_evidence' in track).length, 12);
  assert.ok(Buffer.byteLength(JSON.stringify(enriched)) > 8192);
  assert.ok(enriched.every(track => 'musical_evidence' in track
    && track.musical_evidence.instruments.scores.length === 13));
  assert.equal(JSON.stringify(tracks), before);
});

test('v2.2 exposes a physical envelope limit explicitly instead of silently losing profiles', () => {
  const large = sample('oversized');
  const hugeLabel = 'label-' + 'x'.repeat(2 * 1024 * 1024);
  const over: MusicEvidenceV2 = {
    ...large,
    windows: [{ ...large.windows[0], outputs: [...large.windows[0].outputs,
      outputs('mtg_jamendo_instrument-discogs-effnet-1', hugeLabel, 0.7)] }, large.windows[1]],
  };
  const result = attachCompleteMusicEvidence([{ id: 'oversized' }], new Map([['oversized', over]]));
  assert.equal((result[0] as any).musical_evidence, undefined);
  assert.equal((result[0] as any).musical_evidence_status, 'transport_limit_use_compare');
});

test('v2.2 comparison pages 12 known candidates without spending economic evidence budgets', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `song-${i}`);
  const rows = new Map(ids.map(id => [id, sample(id)]));
  const prev = {
    v22: process.env.SUBWAVE_MUSIC_CONTEXT_UNCAPPED,
    v21: process.env.SUBWAVE_MUSIC_CONTEXT_V21,
    v2: process.env.SUBWAVE_MUSIC_EVIDENCE_V2,
  };
  process.env.SUBWAVE_MUSIC_CONTEXT_UNCAPPED = '1';
  process.env.SUBWAVE_MUSIC_CONTEXT_V21 = '0';
  process.env.SUBWAVE_MUSIC_EVIDENCE_V2 = '1';
  let lookupCalls = 0;
  const build = () => compareMusicalCandidates.build({
    scope: { essentiaDiscovery: true },
    seen: new Map(ids.map(id => [id, { id }])),
    essentia: { lookupV2: async (lookups: string[]) => {
      lookupCalls++;
      assert.ok(lookups.length <= 4);
      return new Map(lookups.map(id => [id, rows.get(id)!]));
    } },
    reserveMusicEvidence: () => { throw new Error('v2.2 must not use the economic ledger'); },
  } as never) as any;
  try {
    const tool = build();
    const seen = new Set<string>();
    for (const offset of [0, 4, 8]) {
      const response = await tool.execute({ ids, offset });
      assert.equal(response.status, 'available');
      assert.equal(response.detail, 'windows');
      assert.equal(response.page.offset, offset);
      assert.equal(response.page.total, 12);
      assert.equal(response.page.hasMore, offset !== 8);
      assert.equal(response.page.nextOffset, offset !== 8 ? offset + 4 : null);
      assert.equal(response.candidates.length, 4);
      assert.ok(response.candidates.every((candidate: any) => {
        seen.add(candidate.id);
        return candidate.window_evidence.features.instrument.scores.length === 13;
      }));
    }
    assert.equal(seen.size, 12);
    assert.equal(lookupCalls, 3);
    const invalidPage = await tool.execute({ ids, offset: 12 });
    assert.equal(invalidPage.status, 'invalid_page');
    const invalidIds = await tool.execute({ ids: ['song-0', 'unknown'] });
    assert.equal(invalidIds.status, 'invalid_candidates');
  } finally {
    for (const [key, value] of [
      ['SUBWAVE_MUSIC_CONTEXT_UNCAPPED', prev.v22],
      ['SUBWAVE_MUSIC_CONTEXT_V21', prev.v21],
      ['SUBWAVE_MUSIC_EVIDENCE_V2', prev.v2],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test('v2.2 classifier differentiates socket response oversize, null and absent evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v22-socket-limits-'));
  const fixtures = [
    { name: 'oversized', reply: `${'x'.repeat(2 * 1024 * 1024 + 1)}\n`, want: 'transport_limit' },
    { name: 'server-limit', reply: '{"version":2,"error":"response_too_large"}\n', want: 'transport_limit' },
    { name: 'backend-null', reply: 'null\n', want: 'unavailable' },
    { name: 'missing', reply: '[]\n', want: 'ok' },
  ];
  for (const { name, reply, want } of fixtures) {
    const path = join(dir, `${name}.sock`);
    const server = createServer(socket => {
      socket.on('error', () => {});
      socket.once('data', data => {
        const request = JSON.parse(data.toString('utf8'));
        assert.equal(request.reportLimits, true);
        socket.end(reply);
      });
    });
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      const result = await lookupMusicEvidenceSocketResult(path, ['fixture']);
      assert.equal(result.status, want);
      if (want === 'transport_limit') assert.equal((result as any).boundary, 'response');
      if (want === 'ok') assert.equal((result as any).rows.size, 0);
      if (name === 'backend-null') assert.equal((result as any).reason, 'unknown');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});

test('v2.2 comparison and discovery retain explicit status without promoting missing data', async () => {
  const previous = {
    v22: process.env.SUBWAVE_MUSIC_CONTEXT_UNCAPPED,
    v2: process.env.SUBWAVE_MUSIC_EVIDENCE_V2,
  };
  process.env.SUBWAVE_MUSIC_CONTEXT_UNCAPPED = '1';
  process.env.SUBWAVE_MUSIC_EVIDENCE_V2 = '1';
  const ids = ['fixture-1', 'fixture-2'];
  const reader = (status: 'transport_limit' | 'unavailable' | 'ok') => ({
    lookup: async () => new Map(),
    search: async () => [],
    lookupV2: async () => null,
    lookupV2Result: async () => status === 'transport_limit'
      ? { status, boundary: 'response' as const }
      : status === 'unavailable' ? { status, reason: 'unknown' as const }
        : { status, rows: new Map() },
  });
  try {
    for (const status of ['transport_limit', 'unavailable', 'ok'] as const) {
      const fake = reader(status);
      const tool = compareMusicalCandidates.build({
        scope: { essentiaDiscovery: true }, seen: new Map(ids.map(id => [id, { id }])),
        essentia: fake, reserveMusicEvidence: () => { throw new Error('economic budget should not be used'); },
      } as never) as any;
      const response = await tool.execute({ ids });
      assert.equal(response.status, status === 'ok' ? 'unavailable' : status);
      if (status === 'transport_limit') {
        assert.equal(response.boundary, 'response');
        assert.equal(response.candidates, undefined);
      }
      if (status === 'unavailable') assert.match(response.note, /temporarily unavailable/);
      await withEssentiaReaderForTest(fake as never, async () => {
        const ctx = buildPickerContext(pickerScope({ essentiaDiscovery: true }));
        const candidates = await ctx.collectAsync(ids.map(id => ({ id, title: id, artist: 'Fixture', duration: 180 })));
        assert.equal(candidates.length, 2);
        assert.equal(ctx.seen.size, 2);
        assert.ok(candidates.every((candidate: any) => candidate.musical_evidence === undefined));
        if (status !== 'ok') {
          assert.ok(candidates.every((candidate: any) => candidate.musical_evidence_status === (
            status === 'transport_limit' ? 'transport_limit_use_compare' : 'lookup_unavailable')));
        }
      });
    }
  } finally {
    for (const [key, value] of [
      ['SUBWAVE_MUSIC_CONTEXT_UNCAPPED', previous.v22],
      ['SUBWAVE_MUSIC_EVIDENCE_V2', previous.v2],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
