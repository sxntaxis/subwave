import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitLyricTheme, lyricThemeTerms, lyricThemeEvidence } from '../src/music/lyrics-theme-core.ts';

test('explicit cues provide a required-evidence guard for any topic', () => {
  assert.equal(explicitLyricTheme('cannabis-related songs'), 'cannabis');
  assert.equal(explicitLyricTheme('songs about cars'), 'cars');
  assert.equal(explicitLyricTheme('songs about cannabis'), 'cannabis');
  assert.equal(explicitLyricTheme('Can you play songs about leaving home?'), 'leaving home');
  assert.equal(explicitLyricTheme('canciones sobre marihuana'), 'marihuana');
  assert.equal(explicitLyricTheme('play some reggae'), null);
  assert.equal(explicitLyricTheme('something hazy and relaxing'), null);
  assert.equal(explicitLyricTheme('more like this'), null);
  assert.equal(explicitLyricTheme('play a song by Bob Marley'), null);
});

test('lyrics supply topical evidence, not artist genre or production descriptors', () => {
  const terms = lyricThemeTerms('cannabis', ['ganja', 'marijuana']);
  assert.ok(terms.some(t => t.text === 'ganja'));
  const explicit = lyricThemeEvidence('The garden grows ganja in the morning.\nThe market sells ganja in the afternoon.', terms);
  assert.equal(explicit?.strength, 'repeated_context');
  assert.ok(explicit?.matchedTerms.includes('ganja'));
  assert.equal(lyricThemeEvidence('The green drums carry deep bass every night.\nThe city is calm today.', terms), null);
});

test('a single ambiguous mention is not promoted to lyrical theme proof', () => {
  const terms = lyricThemeTerms('cannabis', ['blunt']);
  const evidence = lyricThemeEvidence('A song about some other subject.\nAn unrelated blunt reference in the background.', terms);
  assert.equal(evidence?.strength, 'incidental_mention');
  assert.equal(lyricThemeEvidence('A long song about ordinary seaweed and riverbanks,\nnot drugs or smoking.', terms), null);
});

test('bounded evidence does not reveal complete stored lyric texts', () => {
  const terms = lyricThemeTerms('hometown');
  const lyric = Array.from({length: 25}, (_,i) => `My hometown is waiting by the station at dawn number ${i}.`).join('\n');
  const evidence = lyricThemeEvidence(lyric, terms);
  assert.ok(evidence);
  assert.ok(evidence.windows.length <= 3);
  assert.ok(evidence.windows.every(w => w.length <= 240));
  assert.ok(evidence.windows.join(' ').length < lyric.length);
});

test('a lyric embedded late in an unsplit long line is visible to the model', () => {
  const terms = lyricThemeTerms('cannabis', ['sensimilla']);
  const longLine = 'Ordinary instrumental description ' .repeat(20)
    + 'The gardener planted sensimilla behind the old barn, a vivid central image of the song.';
  const evidence = lyricThemeEvidence(longLine, terms);
  assert.ok(evidence);
  assert.ok(evidence.windows.some(w => w.includes('sensimilla')));
  assert.ok(evidence.windows.every(w => w.length <= 240));
});
