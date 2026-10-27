import test from 'node:test';
import assert from 'node:assert/strict';
import {createAudibleLyricsClock} from '../components/skins/sxntax/lyrics/audibleLyricsClock.ts';
import {requestLyricsView, settleLyricsView, lyricsSurfaceMounted} from '../components/skins/sxntax/lyrics/lyricsPresentation.ts';
const point=(station:number|null, media:number|null, mono:number, playing=true, source='icecast') =>
  ({stationPositionMs:station,mediaTimeSeconds:media,monoMs:mono,playing,mediaSource:source});
test('2s network outage does not advance lyrics when audio decoder stops', () => {
  const c=createAudibleLyricsClock();
  assert.equal(c.observe(point(45000,30,0)).positionMs,45000);
  assert.equal(c.observe(point(46000,31,1000)).positionMs,46000);
  assert.equal(c.observe(point(48000,31,3000,false)).positionMs,46000);
  const restored=c.observe(point(49000,32,4000));
  assert.equal(restored.positionMs,47000);
  assert.equal(restored.stationDeltaMs,2000);
  assert.equal(c.observe(point(50000,33,5000)).positionMs,48000);
});
test('recovered 121ms polling latency cannot erase true listener buffering delay', () => {
  const c=createAudibleLyricsClock();
  c.observe(point(10000,3,0));
  c.observe(point(11000,4,1000));
  c.observe(point(13000,4,3000,false));
  for(let i=0;i<10;i++) c.observe(point(14000+1000*i,5+i,4000+i*1000));
  assert.equal(c.observe(point(24000,15,14000)).positionMs,22000);
});
test('a new media source or media timeline reset deliberately reacquires station position', () => {
  const c=createAudibleLyricsClock();
  c.observe(point(10000,5,0));
  c.observe(point(13000,5,3000,false));
  assert.equal(c.observe(point(20000,0,5000,true,'reconnected')).positionMs,20000);
  assert.equal(c.observe(point(21000,1,6000,true,'reconnected')).positionMs,21000);
});
test('a paused station and paused decoder do not run away', () => {
  const c=createAudibleLyricsClock();
  c.observe(point(5000,2,0));
  assert.equal(c.observe(point(5000,2,4000,false)).positionMs,5000);
});
test('transition interruptions follow the latest requested view without clearing preference', () => {
  let phase=requestLyricsView('artwork',true);
  assert.equal(phase,'opening');
  phase=requestLyricsView(phase,false);
  assert.equal(phase,'closing');
  phase=requestLyricsView(phase,true);
  assert.equal(phase,'opening');
  assert.equal(settleLyricsView(phase),'lyrics');
  assert.equal(lyricsSurfaceMounted('closing'),true);
  assert.equal(settleLyricsView('closing'),'artwork');
});
test('station-side pause holds lyrics even when the Icecast media clock plays silence', () => {
  const c=createAudibleLyricsClock();
  c.observe(point(10000,5,0));
  assert.equal(c.observe({...point(10000,8,3000),stationPaused:true}).positionMs,10000);
  assert.equal(c.observe({...point(10000,9,4000),stationPaused:true}).positionMs,10000);
  assert.equal(c.observe(point(11000,10,5000)).positionMs,11000);
});
test('2-second corrected station start converges while decoded audio advances normally', () => {
  const c=createAudibleLyricsClock();
  c.observe(point(10000,5,0));
  c.observe(point(11000,6,1000));
  let result=c.observe(point(14000,7,2000));
  assert.equal(result.positionMs,12850);
  result=c.observe(point(15000,8,3000));
  assert.equal(result.positionMs,14700);
  result=c.observe(point(16000,9,4000));
  assert.equal(result.positionMs,16000);
});
test('2s RTT spike -> 121ms recovery with no audio stall leaves lyrics on audio', async () => {
  const {createStationClock}=await import('../lib/stationClock.ts');
  const EPOCH=Date.parse('2026-10-26T12:00:00Z');
  let mono=0;
  const station=createStationClock(()=>mono);
  const lyrics=createAudibleLyricsClock();
  assert.equal(station.sample(EPOCH,0,121),true);
  mono=121;
  lyrics.observe(point(10000,4,mono));
  mono=2121;
  assert.equal(station.sample(EPOCH+2000,121,2121),false); // reject jittery RTT
  assert.equal(lyrics.observe(point(12000,6,mono)).positionMs,12000);
  mono=2242;
  assert.equal(station.sample(EPOCH+2121,2121,2242),true);
  assert.ok(Math.abs(station.nowMs()! - (EPOCH+2181.5))<120);
  assert.equal(lyrics.observe(point(12121,6.121,mono)).positionMs,12121);
});
test('bad local Date.now is irrelevant to station and audible media clocks', async () => {
  const {createStationClock}=await import('../lib/stationClock.ts');
  let mono=100;
  const clock=createStationClock(()=>mono);
  const lyrics=createAudibleLyricsClock();
  clock.sample(Date.parse('2026-10-26T12:00:00Z'),0,100);
  const original=Date.now;
  try { Date.now=()=>original()+10*60_000;
    lyrics.observe(point(20000,20,100));
    assert.equal(lyrics.observe(point(22000,22,2100)).positionMs,22000);
  } finally { Date.now=original; }
});
