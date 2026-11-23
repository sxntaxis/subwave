import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLyricIntent, lyricHydrationNeeded, mergeLyricConcepts, groundedLyricChoice } from '../src/music/lyrics-intent.js';
import { lyricThemeTerms, lyricThemeEvidence } from '../src/music/lyrics-theme-core.js';

test('cars and cannabis use the SAME LLM-supplied expansion, without any topic dictionary', () => {
  const cars = resolveLyricIntent('songs about cars', {
    kind: 'track', lyrical_mode: 'required', lyrical_subject: 'driving and automobile culture',
    lyrical_concepts: ['vehicles', 'automobiles', 'engines', 'road trips', 'cruising', 'coches'],
  });
  const cannabis = resolveLyricIntent('cannabis-related songs', {
    kind: 'track', lyrical_mode: 'required', lyrical_subject: 'cannabis culture',
    lyrical_concepts: ['marijuana', 'weed', 'ganja', 'kush', 'mota', 'sensimilla'],
  });
  assert.equal(cars?.mode, 'required');
  assert.equal(cannabis?.mode, 'required');
  assert.equal(cars?.topic, 'driving and automobile culture');
  assert.equal(cannabis?.topic, 'cannabis culture');
  assert.ok(cars?.concepts.includes('cars')); // The exact listener subject is retained.
  assert.ok(cannabis?.concepts.includes('cannabis'));
  const terms = lyricThemeTerms(cars!.topic, cars!.concepts);
  assert.ok(terms.some(t => t.text === 'vehicles'));
  assert.ok(terms.some(t => t.text === 'automobiles'));
  assert.ok(terms.some(t => t.text === 'cars'));
  const match = lyricThemeEvidence('The automobiles roll out before dawn.\nThe vehicles meet beside the old garage.', terms);
  assert.ok(match && match.strength === 'repeated_context');
  assert.equal(lyricHydrationNeeded(cars), true);
});

test('without an LLM plan, neither topic gets hard-coded synonyms', () => {
  assert.deepEqual(lyricThemeTerms('cannabis').map(t => t.text), ['cannabis']);
  assert.deepEqual(lyricThemeTerms('cars').map(t => t.text), ['cars']);
  assert.equal(lyricThemeEvidence('Automobiles park beside the garage.\nEngines idle in the morning.', lyricThemeTerms('cars')), null);
});

test('figurative or multilingual expansions remain hypotheses until stored lyrics are interpreted', () => {
  const plan = resolveLyricIntent('canciones sobre carros', {
    kind: 'track', lyrical_mode: 'required', lyrical_subject: 'autos y libertad de viajar',
    lyrical_concepts: ['coches', 'automóviles', 'conducir', 'autopistas', 'roads', 'freeway'],
  });
  assert.equal(plan?.mode, 'required');
  const terms = lyricThemeTerms(plan!.topic, plan!.concepts);
  const evidence = lyricThemeEvidence('The roads lead past distant cities.\nEvery road carries a different story.', terms);
  assert.ok(evidence);
  assert.equal(groundedLyricChoice({ id: 'available', lyrical_basis: 'unsupported', lyrical_reading: 'A roadway is mentioned, but the song may not be about cars.' }, new Set(['available'])), false);
});

test('a model semantic plan is optional for sound-only requests; an explicit lyrical cue survives a wrong none', () => {
  assert.equal(resolveLyricIntent('play some jazz', {
    kind:'track', lyrical_mode:'none', lyrical_subject:null, lyrical_concepts:['drums'],
  }), null);
  const guarded = resolveLyricIntent('songs about cars', {
    kind:'track', lyrical_mode:'none', lyrical_subject:'reggae', lyrical_concepts:['reggae'],
  });
  assert.deepEqual(guarded, {topic:'cars',mode:'required',concepts:[]});
});

test('bounded expansion preserves original subject yet leaves room for new LLM concepts', () => {
  const initial = { topic:'cars', mode:'required' as const,
    concepts:['cars','vehicles','automobiles','road trips','driving','engines'] };
  const revised = { ...initial, concepts:['freeways','motorways','cruising','road movies','races','gasoline'] };
  const merged = mergeLyricConcepts(initial, revised);
  assert.deepEqual(merged.concepts,['cars','vehicles','automobiles','freeways','motorways','cruising']);
  assert.equal(merged.concepts.length,6);
});
