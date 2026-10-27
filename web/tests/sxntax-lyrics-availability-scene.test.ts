import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shouldKeepLyricsScene, shouldShowRequestedLyrics} from '../components/skins/sxntax/lyrics/lyricsMode.ts';

test('incoming loading and provider failure retain a neutral scene, never old words',()=>{
  for(const status of ['loading','error'] as const){
    assert.equal(shouldKeepLyricsScene(true,status,false,false),true);
    assert.equal(shouldShowRequestedLyrics(true,status,null,false,false),false);
  }
});
test('only confirmed absence falls back, retaining preference for the next available recording',()=>{
  const doc={id:'incoming',timing:'plain' as const,lines:[{id:'line',text:'Synthetic'}]};
  assert.equal(shouldKeepLyricsScene(true,'missing',false,false),false);
  assert.equal(shouldKeepLyricsScene(true,'loading',false,false),true);
  assert.equal(shouldShowRequestedLyrics(true,'available',doc,false,false),true);
});
test('explicit close and off-air release scene ownership',()=>{
  assert.equal(shouldKeepLyricsScene(false,'available',false,false),false);
  assert.equal(shouldKeepLyricsScene(true,'available',false,true),false);
});
