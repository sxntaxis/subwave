import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLyricIntent } from '../src/music/lyrics-intent.js';
import { lyricThemeEvidence, lyricThemeTerms, semanticLyricHypothesis } from '../src/music/lyrics-theme-core.js';
import { redactPrivateLyricSlate } from '../src/music/lyrics-privacy.js';

test('explicit lyrical cues remain mandatory if the librarian skips or misclassifies them', () => {
  assert.deepEqual(resolveLyricIntent('cannabis-related songs', null), { topic: 'cannabis', mode: 'required', concepts: [] });
  assert.equal(resolveLyricIntent('songs about cannabis', { kind: 'track', lyrical_mode: 'none' })?.mode, 'required');
});

test('indirect subjects and combined mood/meaning requests route through lyrics without matching a fixed phrase', () => {
  assert.deepEqual(resolveLyricIntent('I wanna hear stories of exile', {
    kind: 'track', lyrical_mode: 'required', lyrical_subject: 'living in exile',
    lyrical_concepts: ['migration', 'homecoming', 'loneliness'],
  }), { topic: 'living in exile', mode: 'required', concepts: ['migration', 'homecoming', 'loneliness'] });
  assert.equal(resolveLyricIntent('something mellow that speaks about grief', {
    kind: 'track', lyrical_mode: 'supporting', lyrical_subject: 'grief', lyrical_concepts: [],
  })?.mode, 'supporting');
});

test('sound, genre, artist, chat and missing subject do not trigger lyrical proof', () => {
  assert.equal(resolveLyricIntent('hazy reggae', { kind: 'track', lyrical_mode: 'none', lyrical_subject: null }), null);
  assert.equal(resolveLyricIntent('play Bob Marley', { kind: 'track', lyrical_mode: 'none', lyrical_subject: null }), null);
  assert.equal(resolveLyricIntent('hello', { kind: 'chat', lyrical_mode: 'required', lyrical_subject: 'hello' }), null);
  assert.equal(resolveLyricIntent('something nice', { kind: 'track', lyrical_mode: 'required', lyrical_subject: null }), null);
});

test('LLM related concepts are retrieval hints, not lyrical proof', () => {
  const terms = lyricThemeTerms('exile', ['homecoming', 'migration']);
  assert.ok(terms.some(t => t.text === 'homecoming'));
  assert.equal(lyricThemeEvidence('Reggae pulses in the warm night. Nothing is mentioned.', terms), null);
  const hypothesis = semanticLyricHypothesis(Array.from({ length: 9 }, (_, i) => `The singer watches a faraway skyline at time ${i}, wondering where the roads go.`).join('\n'));
  assert.equal(hypothesis?.strength, 'semantic_hypothesis');
  assert.equal(hypothesis?.lexicalScore, 0);
  assert.ok((hypothesis?.windows.length ?? 0) <= 4);
});

test('stored lyrical passages are masked from LLM request telemetry, but the rest of the request is preserved', () => {
  const message = 'Request: grief\n[PRIVATE_LYRICS_START]\nprivate song lyric text\n[PRIVATE_LYRICS_END]';
  assert.equal(redactPrivateLyricSlate(message), 'Request: grief\n[PRIVATE LYRICAL EVIDENCE REDACTED]');
});
