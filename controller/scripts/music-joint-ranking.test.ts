import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankMusicCandidates } from '../src/music/music-joint-ranking.mjs';

test('joint ranking evaluates every candidate and prioritizes complete evidence', () => {
  const preferences = [
    { family: 'arousal', key: 'value', direction: 'low' },
    { family: 'voice', key: 'value', direction: 'low' },
    { family: 'instrument', key: 'piano', direction: 'high' },
  ];
  const many = Array.from({ length: 300 }, (_, i) => ({
    id: `high-arousal-${i}`, values: { arousal: { value: 0.01 }, voice: { value: 0.9 }, instrument: { piano: 0.01 } },
  }));
  const ranked = rankMusicCandidates([
    ...many,
    { id: 'rare-piano', values: { arousal: { value: 0.1 }, voice: { value: 0.1 }, instrument: { piano: 0.9 } } },
    { id: 'partial', values: { arousal: { value: 0 } } },
  ], preferences);
  assert.equal(ranked?.[0].id, 'rare-piano');
  assert.equal(ranked?.at(-1).id, 'partial');
  assert.equal(ranked?.at(-1).tier, 'partial');
  assert.equal(rankMusicCandidates([{ id: 'partial', values: { arousal: { value: 0 } } }], preferences, ['instrument'])?.length, 0);
});

test('missing one requested label in the same family is partial, not full', () => {
  const preferences = [
    { family: 'instrument', key: 'piano', direction: 'high' },
    { family: 'instrument', key: 'guitar', direction: 'high' },
  ];
  const candidates = [
    { id: 'partial', values: { instrument: { piano: 1 } } },
    { id: 'full', values: { instrument: { piano: 0.2, guitar: 0.2 } } },
  ];
  const result = rankMusicCandidates(candidates, preferences);
  assert.equal(result?.[0].id, 'full');
  assert.equal(result?.[1].tier, 'partial');
  assert.equal(result?.[1].evidenceCoverage, 0.5);
  assert.equal(rankMusicCandidates(candidates, preferences, ['instrument'])?.length, 1);
});
