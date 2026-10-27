import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
test('controller timestamps the now-playing response at the shared server epoch', () => {
  const route = readFileSync(new URL('../../controller/src/routes/public.ts', import.meta.url), 'utf8');
  assert.match(route, /serverTimeMs:\s*Date\.now\(\),\s*nowPlaying,/);
});
test('station feed synchronizes to the response, and delays spoken and track events in that time domain', () => {
  const feed = source('hooks/useStationFeed.ts');
  assert.match(feed, /stationClock\.sample\(npRes\.serverTimeMs, stateStartedAt, receivedMono\)/);
  assert.match(feed, /const wait = audibleAt - now/);
  assert.match(feed, /splitAudibleTurns\(raw\.messages, leadMsRef\.current, now\)/);
  assert.match(feed, /serverStart \+ leadMs/);
});
test('native lyric renderer uses station time, never client Date.now', () => {
  const renderer = source('components/skins/sxntax/lyrics/LyricsPerspective.tsx');
  assert.match(renderer, /stationClock\?\.nowMs\(\)/);
  assert.match(renderer, /liveRadioLyricsPositionMs\(start, paused, duration, stationNow\)/);
  assert.doesNotMatch(renderer, /Date\.now\(\)/);
});
test('all skins with clock-driven progress use their station clock', () => {
  for(const skin of ['sxntax/SxntaxSkin.tsx', 'subamp/SubampSkin.tsx', 'unit/UnitSkin.tsx', 'platter/PlatterSkin.tsx', 'drift/DriftSkin.tsx', 'tty/TtySkin.tsx','classic/CenterStage.tsx']) {
    assert.match(source('components/skins/'+skin), /useElapsed\(trackStartedAt, trackPausedAt, stationClock\)/, skin);
  }
  assert.match(source('components/skins/classic/Waveform.tsx'), /playbackElapsedSeconds\(trackStartedAt, trackPausedAt, stationNow\)/);
});
