import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLyricsPreview } from '../components/skins/sxntax/lyrics/lyricsPreview';
import { lyricsCursorAt, validLyricDocument, type LyricDocument } from '../components/skins/sxntax/lyrics/lyricsModel';

test('all preview fixture modes are valid and use only synthetic text', () => {
  for (const mode of ['plain', 'line', 'word'] as const) {
    const doc = createLyricsPreview(mode);
    assert.equal(doc.timing, mode);
    assert.ok(validLyricDocument(doc));
    assert.equal(doc.lines.length, 6);
    assert.ok(doc.id.startsWith('synthetic-'));
  }
});

test('plain lyrics are never highlighted even when the clock advances', () => {
  const doc = createLyricsPreview('plain');
  assert.deepEqual(lyricsCursorAt(doc, 22_000), { line: -1, segment: -1 });
});

test('line timing begins at the first actual timestamp, without nearest-line guessing', () => {
  const doc = createLyricsPreview('line');
  assert.deepEqual(lyricsCursorAt(doc, 1799), { line: -1, segment: -1 });
  assert.deepEqual(lyricsCursorAt(doc, 1800), { line: 0, segment: -1 });
  assert.deepEqual(lyricsCursorAt(doc, 6600), { line: 1, segment: -1 });
  assert.deepEqual(lyricsCursorAt(doc, null), { line: -1, segment: -1 });
  assert.deepEqual(lyricsCursorAt(doc, Number.NaN), { line: -1, segment: -1 });
});

test('word timing never interpolates missing segments or past an explicit end', () => {
  const doc = createLyricsPreview('word');
  assert.deepEqual(lyricsCursorAt(doc, 1800), { line: 0, segment: 0 });
  assert.deepEqual(lyricsCursorAt(doc, 1800 + 481), { line: 0, segment: 1 });
  assert.deepEqual(lyricsCursorAt(doc, 1800 + 4400), { line: -1, segment: -1 });
});

test('end timestamp suppresses current line in a real gap rather than keeping karaoke active', () => {
  const doc: LyricDocument = { id: 'test', timing: 'line', lines: [
    { id: 'a', text: 'First', startMs: 1000, endMs: 2000 },
    { id: 'b', text: 'Second', startMs: 3500 },
  ] };
  assert.ok(validLyricDocument(doc));
  assert.deepEqual(lyricsCursorAt(doc, 2400), { line: -1, segment: -1 });
  assert.deepEqual(lyricsCursorAt(doc, 3500), { line: 1, segment: -1 });
});

test('invalid ordering, contradictory segments and duplicate identities are rejected', () => {
  const original = createLyricsPreview('word');
  const first = original.lines[0]!;
  assert.equal(validLyricDocument({ ...original, lines: [first, { ...first }] }), false);
  assert.equal(validLyricDocument({ ...original, lines: [original.lines[1]!, first] }), false);
  assert.equal(validLyricDocument({ ...original, lines: [
    { ...first, segments: [{ text: 'not the same text', startMs: 1800, endMs: 2000 }] },
  ] }), false);
});
