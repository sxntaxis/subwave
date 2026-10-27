import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { shouldShowRequestedLyrics } from '../components/skins/sxntax/lyrics/lyricsMode.ts';
import { presentedLyricPosition } from '../components/skins/sxntax/lyrics/presentedLyricsClock.ts';
const read = (p) => readFileSync(new URL(`../components/skins/sxntax/${p}`, import.meta.url), 'utf8');
test('lyrics intent is separate from availability and survives unavailable songs', () => {
  const doc = { id: 'fixture', timing: 'line', lines: [{id:'a',text:'test',startMs:0,endMs:1000}] };
  assert.equal(shouldShowRequestedLyrics(true,'available',doc,false,false),true);
  for (const s of ['loading','missing','error']) assert.equal(shouldShowRequestedLyrics(true,s,null,false,false),false);
  assert.equal(shouldShowRequestedLyrics(true,'available',doc,false,false),true);
  assert.equal(shouldShowRequestedLyrics(false,'available',doc,false,false),false);
});
test('the active lyric literally shares the song title shadow and content width', () => {
  const css = read('lyrics/LyricsPerspective.module.css');
  const global = read('Sxntax.module.css');
  assert.match(css,/text-shadow:\s*var\(--sx-title-glow\)/);
  assert.match(global,/--sx-title-glow:/);
  assert.match(css,/--lyplus-padding-line:\s*clamp\(0px, \.40vw, 4px\)/);
  assert.match(css,/max-width:\s*none/);
  assert.match(css,/padding-inline:\s*var\(--lyplus-padding-line\) !important/);
  assert.match(read('lyrics/vendor/youlyplus/lyrics.scoped.css'),/padding-right: 20%/); // native duet reservation overridden by module

});
test('compact identity and transcript share normal handoff and top-aligned cover geometry', () => {
  const css = read('Sxntax.module.css');
  const view = read('SxntaxSkin.tsx');
  assert.match(css,/\.lyricsTrackIdentity\s*\{[^}]*align-items:\s*flex-start/s);
  assert.match(css,/\.coverPlate\.lyricsCoverPlate\s*\{[^}]*align-self:\s*flex-start/s);
  assert.match(css,/\.lyricsCompactOutgoing\s*\{[^}]*--sx-bridge-out-core/s);
  assert.match(css,/\.lyricsCompactIncoming\s*\{[^}]*--sx-bridge-in-core/s);
  assert.match(view,/data-lyrics-intent=/);
});
test('native lyric scroll pins its last timed line and reserves a stable endcard', () => {
  const vendor = read('lyrics/vendor/youlyplus/lyricsRenderer.js');
  const view = read('lyrics/LyricsPerspective.tsx');
  assert.match(vendor,/predictiveTime >= lines\[linesLen - 1\]\._endTimeMs/);
  assert.match(vendor,/lineToScroll = lines\[linesLen - 1\]/);
  assert.match(view,/data-lyrics-endcard/);
  assert.match(view,/transcript\.appendChild\(node\)/);
});

test('incoming on-air clock does not rewind outgoing presented lyrics', () => {
  const prior={key:'outgoing-song',ms:186200};
  assert.equal(presentedLyricPosition('outgoing-song','outgoing-song',186800,prior),186800);
  assert.equal(presentedLyricPosition('outgoing-song','incoming-song',1500,prior),186200);
  assert.equal(presentedLyricPosition('incoming-song','incoming-song',1500,prior),1500);
  assert.equal(presentedLyricPosition('other-song','incoming-song',1500,prior),null);
});
