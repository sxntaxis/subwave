import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const root = new URL('../components/skins/sxntax/', import.meta.url);
const read=(file)=>fs.readFileSync(new URL(file,root),'utf8');
test('view toggle uses reversible presentation phase, not instant conditional unmount',()=>{
 const src=read('SxntaxSkin.tsx');
 assert.match(src,/requestLyricsView\(phase, lyricsOpen\)/);
 assert.match(src,/data-lyrics-view=\{lyricsViewPhase\}/);
 assert.match(src,/lyricsSceneActive && \(\s*<LyricsPerspective/);
 assert.match(src,/renderedLyrics = liveLyricSnapshot/);
 assert.match(src,/setLyricsWanted\(false\)/);
 assert.doesNotMatch(src,/if \(lyricsWanted && !lyricsOpen\) setLyricsWanted\(false\)/);
});
test('motion inherits centered phosphor decay without new scenes or renderer duplication',()=>{
 const css=read('Sxntax.module.css'),src=read('SxntaxSkin.tsx');
 assert.match(css,/sx-lyrics-projection-resolve/);
 assert.match(css,/sx-lyrics-projection-disperse/);
 assert.match(css,/lyricsHandoffAfterimage/);
 assert.match(src,/lyricsHandoffAfterimage/);
 assert.match(css,/prefers-reduced-motion/);
 assert.equal((src.match(/<LyricsPerspective/g)||[]).length,1);
});
test('ECO retains timed native word documents while suppressing decorative transforms and spring follow',()=>{
 const view=read('lyrics/LyricsPerspective.tsx'),native=read('lyrics/vendor/youlyplus/lyricsRenderer.js'),css=read('lyrics/LyricsPerspective.module.css');
 assert.match(view,/wordByWord: true/);
 assert.match(view,/blurInactive: !lite, relaxScroll: !lite, bkgOverlap: !lite/);
 assert.match(native,/this\.currentSettings\?\.lightweight/);
 assert.match(css,/data-lyrics-rendering='eco'/);
 assert.match(css,/transition-property: color, opacity/);
});
test('options hidden without removing translation or stored offset controls',()=>{
 const css=read('lyrics/LyricsPerspective.module.css'),view=read('lyrics/LyricsPerspective.tsx');
 assert.match(css,/#lyrics-plus-reload-button/);
 assert.match(view,/lyrics-offset:/);
 assert.match(view,/switchDisplayMode/);
});
test('renderer anchors karaoke to decoded audio and exposes recovery state',()=>{
 const view=read('lyrics/LyricsPerspective.tsx'),hook=read('lyrics/audibleLyricsClock.ts');
 assert.match(view,/audioElement= null|audioElement = null/);
 assert.match(view,/data-lyrics-clock-state=\{reportedAudibleMode\}/);
 assert.match(view,/audible\.current\.observe/);
 assert.match(hook,/mediaLag/);
 assert.match(hook,/stationPaused/);
});
