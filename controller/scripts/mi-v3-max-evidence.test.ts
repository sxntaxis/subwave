import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseDirectorCatalogueSample } from '../src/broadcast/dj-agent/director-v3-evidence.js';
import { directorV3GroundingCheck } from '../src/broadcast/dj-agent/director-v3-core.js';
import { maximalMusicEvidence, attachMaximalMusicEvidence } from '../src/music/music-evidence-profile.js';
import { readVerifiedModelProfiles } from '../src/music/music-evidence-reader.js';
import type { EssentiaReader } from '../src/music/essentia-evidence.js';
import type { MusicEvidenceV2 } from '../src/music/musical-evidence-v2.js';

function source(id: string): MusicEvidenceV2 {
  const model = (modelId: string, label: string, value: number, nativeScale = 'model native; see metadata') =>
    ({ modelId, label, value, nativeScale, missingReason: null, validity: 'valid' });
  return {
    trackId: id, analysisId: 'a', runId: 'r', modelsHash: 'verified',
    sourceSize: '1234', sourceMtimeNs: '5678', expectedWindows: 3,
    windows: (['opening', 'body', 'ending'] as const).map((role, i) => ({
      role, startMs: i * 1000, endMs: (i + 1) * 1000, outputs: [
        model('deam-msd-musicnn-2', 'arousal', 2 + i, 'DEAM native [1,9], valence then arousal'),
        model('deam-msd-musicnn-2', 'valence', 5, 'DEAM native [1,9], valence then arousal'),
        model('mtg_jamendo_instrument-discogs-effnet-1', 'piano', 0.85),
        model('mtg_jamendo_instrument-discogs-effnet-1', 'saxophone', 0.18),
        model('mtg_jamendo_moodtheme-discogs-effnet-1', 'relaxing', 0.73),
        model('mtg_jamendo_moodtheme-discogs-effnet-1', 'melancholic', 0.23),
        model('voice_instrumental-discogs-effnet-1', 'voice', 0.12),
        model('voice_instrumental-discogs-effnet-1', 'instrumental', 0.88),
        model('timbre-discogs-effnet-1', 'bright', 0.56),
        model('timbre-discogs-effnet-1', 'dark', 0.44),
        model('danceability-discogs-effnet-1', 'danceable', 0.39),
        model('danceability-discogs-effnet-1', 'not_danceable', 0.61),
      ],
    })),
  };
}

test('maximal profile retains all verified heads and sparse time windows; no raw identity', () => {
  const profile = maximalMusicEvidence(source('track-internal'));
  assert.deepEqual(profile.instruments.scores.map(x => x.label), ['piano', 'saxophone']);
  assert.deepEqual(profile.moodThemes.scores.map(x => x.label), ['relaxing', 'melancholic']);
  assert.deepEqual(profile.remainingModelHeads.voice.scores.map(x => x.label), ['instrumental', 'voice']);
  assert.deepEqual(profile.remainingModelHeads.timbre.scores.map(x => x.label), ['bright', 'dark']);
  assert.deepEqual(profile.remainingModelHeads.danceability.scores.map(x => x.label), ['not_danceable', 'danceable']);
  assert.equal(profile.arousal.coverage, 'complete');
  assert.equal((profile.sampledWindows.features.arousal as any).samples.length, 3);
  assert.ok(!JSON.stringify(profile).includes('track-internal'));
  const attached = attachMaximalMusicEvidence([{ id: 'track-internal' }], new Map([['track-internal', source('track-internal')]]));
  assert.equal(attached.length, 1);
  assert.ok(attached[0].musical_evidence);
});

test('verified socket transport-limit splits the same IDs and does not invent missing rows', async () => {
  const calls: string[][] = [];
  const reader = {
    lookupV2Result: async (ids: readonly string[]) => {
      calls.push([...ids]);
      if (ids.length > 1) return { status: 'transport_limit', boundary: 'response' } as const;
      return { status: 'ok', rows: new Map(ids[0] === 'lost' ? [] : [[ids[0], source(ids[0])]]) } as const;
    },
  } as EssentiaReader;
  const result = await readVerifiedModelProfiles(['first', 'lost', 'third'], reader);
  assert.equal(result.status, 'partial');
  assert.equal(result.profiles.size, 2);
  assert.equal(result.profiles.has('lost'), false);
  assert.ok(calls.some(ids => ids.length === 3));
  assert.ok(calls.some(ids => ids.length === 1));
});

test('catalogue sampling rotates, respects exclusions, and avoids repeat artists when possible', () => {
  const tracks = Array.from({ length: 70 }, (_, i) => ({
    id: `id${i}`, artist: `Artist ${Math.floor(i / 2)}`, moods: [i % 2 ? 'warm' : 'dark'],
    energy: i % 3 ? 'low' : 'high', genres: ['Jazz'],
  }));
  const exclude = new Set(['id0', 'id2']);
  const one = chooseDirectorCatalogueSample(tracks, { moods: ['warm'] }, exclude, 0, 12);
  const two = chooseDirectorCatalogueSample(tracks, { moods: ['warm'] }, exclude, 20 * 60_000, 12);
  assert.equal(one.length, 12);
  assert.ok(one.every(t => t.moods.includes('warm')));
  assert.ok(one.every(t => !exclude.has(t.id)));
  assert.equal(new Set(one.map(t => t.artist)).size, 12);
  assert.notDeepEqual(one.map(t => t.id), two.map(t => t.id));
});

test('director grounds decisions in available verified acoustic references; no index means no false gate', () => {
  assert.equal(directorV3GroundingCheck({ reason: 'H1 measured falling arousal, C2 has piano evidence' }, ['H1', 'C2']), true);
  assert.equal(directorV3GroundingCheck({ reason: 'An organic, luminous drift' }, ['H1', 'C2']), false);
  assert.equal(directorV3GroundingCheck({ reason: 'H1 is measured' }, ['H1', 'C2']), false);
  assert.equal(directorV3GroundingCheck({ reason: 'H1 plus invented C99' }, ['H1', 'C2']), false);
  assert.equal(directorV3GroundingCheck({ reason: 'No acoustic data; creative direction only' }, []), true);
  assert.equal(directorV3GroundingCheck({ action: 'defer', reason: 'Unknown available evidence' }, ['H1', 'C2']), true);
});
