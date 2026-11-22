// MI v2.5.1 H02: exercise the real Queue.onTrackStarted boundary with a fabricated
// mixer marker and an isolated SQLite library. No network, live state, or audio.
// This is intentionally ONE sequential test: the production Queue and
// musicDirection are singletons; parallel cases could conceal attribution bugs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-mi-v251-h02-'));
process.env.STATE_DIR = stateDir;
process.env.SUBWAVE_MUSIC_DIRECTION_V1 = '1';
process.env.SUBWAVE_MUSIC_DIRECTOR_V2 = '1';
process.env.SUBWAVE_MUSIC_TRAJECTORY_V1 = '1';
process.env.SUBWAVE_MI_EXPANDED_PICKER = '1';

// All application imports are dynamic and occur AFTER STATE_DIR and flags are
// set. In particular the direction sidecar and library DB must resolve here.
const [db, library, { queue }, { trackFields }, { musicDirection }, { projectVerifiedAirplay }] = await Promise.all([
  import('../src/music/library-db.js'),
  import('../src/music/library.js'),
  import('../src/broadcast/queue.js'),
  import('../src/broadcast/dj-agent/enqueue.js'),
  import('../src/broadcast/dj-agent/music-direction.js'),
  import('../src/broadcast/dj-agent/verified-airplay-context.js'),
]);

type Snapshot = { lastStart: string | null; memory: { recent: Array<{
  eventId: string; trackId: string | null; artist: string | null;
  energy: string | null; genre: string | null; moods: string[];
}> } };
const read = (): Snapshot => {
  const file = join(stateDir, 'music-direction-v1.json');
  return existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { lastStart:null, memory:{recent:[]} };
};
const events = () => read().memory.recent;
const now = Math.floor(Date.now() / 1000);
const marker = (id: string, timestamp: number, token?: string, extra: Record<string, unknown> = {}) => ({
  subsonic_id: id, title: id, artist: 'Test Artist', album: '', timestamp,
  ...(token ? { subwave_queue_token: token } : {}), ...extra,
});
let sequence = 0;
const start = (id: string, token?: string, extra: Record<string, unknown> = {}) => {
  queue.onTrackStarted(marker(id, now + sequence++ * 2, token, extra) as any);
};
function seed(id: string, energy: 'low' | 'medium' | 'high', year = 2017, originalYear = 1974) {
  db.upsertTrackMeta(id, {
    title:id, artist:'Test Artist', album:'Synthetic fixture', year, originalYear,
    genres:['Jazz', 'Fusion'], duration:240,
  });
  db.upsertTrackTags(id, { moods:['warm', 'playful'], energy, source:'manual' });
}

// Stub ONLY outbound effects, not admission, mixer attribution, sidecar writes
// or DB reads. Direct Queue.onTrackStarted and MusicDirectionStore run normally.
const saved = {
  persist:queue.persist, persistRecentPlays:queue.persistRecentPlays,
  drainToLiquidsoap:queue.drainToLiquidsoap, airIntro:queue.airIntro,
  airPendingVoice:queue.airPendingVoice, log:queue.log,
  warnIfSwallowedByCrossfade:queue.warnIfSwallowedByCrossfade,
};
let queueWrites = 0;
queue.persist = () => { queueWrites++; };
queue.persistRecentPlays = () => {};
queue.drainToLiquidsoap = async () => {};
queue.airIntro = async () => {};
queue.airPendingVoice = async () => {};
queue.log = () => {};
queue.warnIfSwallowedByCrossfade = () => {};
queue.autoPick = false;
queue.autoLink = false;

async function admit(id: string, kind: 'agent' | 'pool' | 'listener' | 'operator') {
  let token = '';
  const original = { id, title:id, artist:'Test Artist', energy:'low', moods:['decoy'], genre:'Fictional' };
  const track = kind === 'agent' || kind === 'pool' ? trackFields(original) : original;
  const before = events().length;
  const position = await queue.push({ track,
    aiPicked:kind==='agent' || kind==='pool',
    requestedBy:kind==='listener' ? 'test-listener' : kind==='operator' ? 'studio' : null,
    humanRequestId:kind==='listener' ? `request-${id}` : undefined,
    operator:kind==='operator',
  }, (receipt) => { token = receipt.token; });
  assert.equal(position, 1, `${kind}: accepted into the real queue`);
  assert.equal(events().length, before, `${kind}: queue acceptance must not advance history`);
  assert.ok(token, `${kind}: exact insertion receipt`);
  queue.upcoming[0].sent = true; // fabricated mixer has accepted the audio URI
  return token;
}

test('H02: real queue + exact-id library + verified mixer + durable editorial memory', async () => {
  try {
    await db.open({ embeddingDim:db.AUDIO_EMBEDDING_DIM, adoptStoredDim:true });
    await library.load();
    seed('agent-one','high');
    seed('pool-one','medium');
    seed('listener-one','low');
    seed('operator-one','high');
    seed('auto-one','medium');
    seed('stem-one','high');
    // The durable start sidecar starts empty, not on queue push.
    assert.equal(musicDirection.recentVerifiedAirplay().length,0);

    for (const [id, kind, expected] of [
      ['agent-one','agent','high'], ['pool-one','pool','medium'],
      ['listener-one','listener','low'], ['operator-one','operator','high'],
    ] as const) {
      const token = await admit(id,kind);
      const before=events().length;
      const stamp=now+sequence*2;
      start(id,token);
      assert.equal(events().length,before+1,`${kind}: one real mixer start`);
      assert.equal(events()[0].trackId,id);
      assert.equal(events()[0].energy,expected,`${kind}: real library beats decoy queue metadata`);
      assert.deepEqual(events()[0].moods,['warm','playful']);
      assert.match(events()[0].genre ?? '',/Jazz/);
      assert.equal(queue.current?.track.id,id);
      if (kind==='listener' || kind==='operator') {
        assert.equal(musicDirection.snapshot(null)?.steering?.source,kind==='listener'?'listener':'admin');
        assert.equal(musicDirection.snapshot(null)?.steering?.anchorTrackId,id);
      }
      assert.equal(queue.upcoming.length,0);
      assert.ok(read().lastStart?.includes(String(stamp)));
      queue.onTrackStarted(marker(id,stamp,token) as any);
      assert.equal(events().length,before+1,`${kind}: same mixer stamp must not duplicate`);
    }

    // Queue token alone cannot validate a musical identity whose mixer ID
    // contradicts the queued exact ID. The queue may recover its position,
    // but the editorial ledger must not invent that the queued ID played.
    const mismatchToken=await admit('agent-one','agent');
    const mismatchBefore=events().length;
    queue.onTrackStarted(marker('different-mixer-id',now+sequence++*2,mismatchToken,
      {title:'agent-one'}) as any);
    assert.equal(events().length,mismatchBefore+1);
    assert.equal(events()[0].trackId,null,'mismatched mixer ID must not enter verified history');
    assert.equal(events()[0].energy,null);
    assert.deepEqual(events()[0].moods,[]);

    const beforeAuto=events().length;
    start('auto-one');
    assert.equal(events().length,beforeAuto+1,'untracked auto play is recorded');
    assert.equal(events()[0].energy,'medium','auto.m3u gets library facts after real start');
    assert.equal(queue.current?.source,'auto');

    // Unknown/missing catalogue IDs never borrow another song's analysis.
    start('unindexed');
    assert.equal(events()[0].trackId,'unindexed');
    assert.equal(events()[0].energy,null);
    assert.deepEqual(events()[0].moods,[]);

    // A live tokened HUMAN request with the same song ID must not be attributed
    // to an un-tokened auto marker. The exact human token is required.
    const humanToken=await admit('listener-one','listener');
    const beforeImposter=events().length;
    start('listener-one'); // no token: do not consume pending human queue item
    assert.equal(events().length,beforeImposter+1);
    assert.equal(queue.upcoming.length,1);
    assert.equal(queue.current?.source,'auto');
    start('listener-one',humanToken);
    assert.equal(queue.upcoming.length,0);
    assert.equal(queue.current?.source,'request');

    // A start with the same ID but a different mixer stamp represents a real
    // repeated airplay, not a duplicate, even when the song name is identical.
    const repeatedBefore=events().length;
    start('listener-one');
    assert.equal(events().length,repeatedBefore+1);
    assert.notEqual(events()[0].eventId,events()[1].eventId);
    const projected=projectVerifiedAirplay(musicDirection.recentVerifiedAirplay(12),null);
    assert.deepEqual(projected.entries.slice(0,2).map(x=>x.historyRef),['H1','H2']);
    assert.equal(projected.entries[0].showScope,'unknown');
    assert.equal(projected.entries[1].showScope,'unknown');

    // A stem clip and its full-song continuation are one audible start.
    let stemToken='';
    const stemPosition=await queue.push({ track:{ id:'stem-one',title:'stem-one',artist:'Test Artist' },aiPicked:true },
      receipt=> {stemToken=receipt.token;});
    assert.equal(stemPosition,1);
    queue.upcoming[0].sent=true;
    queue.upcoming[0].stemSeam=true;
    const clipStamp=now+sequence++*2;
    const beforeStem=events().length;
    queue.onTrackStarted(marker('stem-one',clipStamp,undefined,{subwave_clip:true}) as any);
    assert.equal(events().length,beforeStem+1);
    assert.equal(queue.current?.stemClipStarted,true);
    queue.onTrackStarted(marker('stem-one',clipStamp+1,stemToken) as any);
    assert.equal(events().length,beforeStem+1,'full-song stem continuation is not a second event');
    assert.equal(queue.current?.stemClipStarted,true);

    // Durable factual history records every distinct verified mixer start,
    // including the mismatched marker whose musical identity is unknown.
    // The narrower acoustic trajectory feed admits only identity-proven starts.
    const durableRecent = events().slice(0,12);
    const recentAirplay = musicDirection.recentVerifiedAirplay(12);
    assert.deepEqual(
      recentAirplay.map(e=>({eventId:e.eventId,trackId:e.trackId})),
      durableRecent.map(e=>({eventId:e.eventId,trackId:e.trackId})),
      'factual history retains the mismatched mixer start with a null track ID',
    );
    assert.equal(recentAirplay.filter(e=>e.trackId===null).length,1,
      'one confirmed start remains explicitly unidentified');
    assert.deepEqual(
      musicDirection.recentVerifiedStarts(null,8).map(e=>({eventId:e.eventId,trackId:e.trackId})),
      durableRecent.filter(e=>e.trackId!==null).slice(0,8)
        .map(e=>({eventId:e.eventId,trackId:e.trackId})),
      'trajectory identity feed excludes unknown IDs and retains the eight most recent proven starts',
    );
    assert.ok(queueWrites>0,'real Queue invoked its usual persistence chokepoint');
  } finally {
    Object.assign(queue,saved);
    // recordPlay is fire-and-forget, but its queued microtasks must complete
    // before closing the fabricated DB and deleting the state directory.
    await new Promise<void>(resolve=>setImmediate(resolve));
    library.shutdown();
    rmSync(stateDir,{recursive:true,force:true});
  }
});
