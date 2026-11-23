import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLyricIntent, needsLyricalMeaningReview, groundedLyricChoice, lyricHydrationNeeded, mergeLyricConcepts,
} from '../src/music/lyrics-intent.js';
import { redactPrivateLyricSlate, redactLyricToolResult } from '../src/music/lyrics-privacy.js';

test('normal sonic/artist requests require no librarian preflight or lyric pass', () => {
  for (const q of ['hazy reggae', 'play something atmospheric', 'play Bob Marley', 'late-night jazz']) {
    assert.equal(resolveLyricIntent(q), null);
    assert.equal(needsLyricalMeaningReview(q), false);
    assert.equal(lyricHydrationNeeded(null), false);
  }
});

test('explicit topics require evidence but never preload ahead of the model semantic plan', () => {
  const early = resolveLyricIntent('cannabis-related songs');
  assert.equal(early?.mode, 'required');
  assert.equal(resolveLyricIntent('songs about cannabis', { kind: 'track', lyrical_mode: 'none' })?.mode, 'required');
  assert.equal(lyricHydrationNeeded(early), true);
});

test('indirect semantics declared by request DJ force a grounded second pass', () => {
  const late = resolveLyricIntent('something about people longing for home', {
    kind: 'track', lyrical_mode: 'required', lyrical_subject: 'homesickness',
    lyrical_concepts: ['exile', 'returning home'],
  });
  assert.equal(late?.topic, 'homesickness');
  assert.equal(lyricHydrationNeeded(late), true);
});

test('conflicting story cues invoke a conditional librarian review, not a keyword verdict', () => {
  assert.equal(needsLyricalMeaningReview('I want stories of migration'), true);
  assert.equal(needsLyricalMeaningReview('a track where the lyrics speak of loss'), true);
  assert.equal(needsLyricalMeaningReview('rainy day'), false);
});

test('unsupported or arbitrary tracks cannot pass required lyrical admission', () => {
  const ids = new Set(['real-lyric-id']);
  assert.equal(groundedLyricChoice({ id:'made-up', lyrical_basis:'central', lyrical_reading:'A thoughtful meaning statement.' }, ids),false);
  assert.equal(groundedLyricChoice({ id:'real-lyric-id', lyrical_basis:'incidental', lyrical_reading:'A thoughtful meaning statement.' }, ids),false);
  assert.equal(groundedLyricChoice({ id:'real-lyric-id', lyrical_basis:'central', lyrical_reading:'' }, ids),false);
  assert.equal(groundedLyricChoice({ id:'real-lyric-id', lyrical_basis:'contextual', lyrical_reading:'A sustained and relevant narrative.' }, ids),true);
});

test('new LLM concepts can request one bounded retrieval expansion even when the first plan is full', () => {
  const first = { topic:'cars', mode:'required' as const,
    concepts:['cars','vehicles','automobiles','motors','driving','highways'] };
  const later = { ...first, concepts:['garages','road trips','racing'] };
  assert.deepEqual(mergeLyricConcepts(first, later).concepts,
    ['cars','vehicles','automobiles','garages','road trips','racing']);
  assert.equal(lyricHydrationNeeded(first), true);
  assert.equal(lyricHydrationNeeded(null), false);
});

test('private lyric tool passages and prompt excerpts never reach audit copies', () => {
  const tool = [{id:'stable-id',lyricalEvidence:{windows:['private lyric line'],matchedTerms:['ganja'],strength:'specific_mention'}}];
  const safe = redactLyricToolResult(tool) as any;
  assert.equal(safe[0].id,'stable-id');
  assert.deepEqual(safe[0].lyricalEvidence.windows,'[PRIVATE LYRICAL EVIDENCE REDACTED]');
  assert.doesNotMatch(JSON.stringify(safe),/private lyric line/);
  const prompt='User asks for a theme\n[PRIVATE_LYRICS_START]\nsecret lyric passage\n[PRIVATE_LYRICS_END]';
  assert.doesNotMatch(redactPrivateLyricSlate(prompt),/secret lyric passage/);
});
