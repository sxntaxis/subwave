// The Lab's music-only persona must be able to use real musical transitions
// without enabling DJ voice behavior. All changes are opt-in and fail back
// to the v2.5.1 mixing policy when the flag is absent.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { QueueItem } from '../src/broadcast/queue/types.js';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-mi-v3-music-mixing-'));
const originalMixingFlag = process.env.SUBWAVE_MUSIC_MIXING_V1;
process.env.STATE_DIR = stateDir;
process.env.SUBWAVE_MUSIC_MIXING_V1 = '0';

const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const dj = await import('../src/llm/dj.js');

async function silentPersona() {
  await settings.load();
  const original = settings.get().personas;
  assert.ok(original.length > 0, 'fixture requires a persona');
  await settings.update({ personas: original.map(p => ({ ...p, djMode: false })) });
  assert.equal(settings.getEffectivePersona()?.djMode, false);
}

test('mixcraft is opt-in and independent of the voice persona', async () => {
  await silentPersona();
  process.env.SUBWAVE_MUSIC_MIXING_V1 = '0';
  const frequencyBefore = settings.effectiveFrequency();
  assert.equal(settings.effectsActive(), false);
  assert.equal(queue.pairDrainActive(), false);

  process.env.SUBWAVE_MUSIC_MIXING_V1 = '1';
  assert.equal(settings.effectsActive(), true);
  assert.equal(queue.pairDrainActive(), true);
  assert.match(dj.effectsGuidance(), /TRANSITION EFFECTS/,
    'silent persona receives music-only transition coaching');
  assert.equal(settings.getEffectivePersona()?.djMode, false,
    'enabling music mixing must never change speech policy');
  assert.equal(settings.effectiveFrequency(), frequencyBefore,
    'music mixing must not increase voice frequency');
});

test('silent persona can arm an outgoing effect and size a real pair independently', async () => {
  process.env.SUBWAVE_MUSIC_MIXING_V1 = '1';
  await settings.update({ crossfadeDuration: 10,
    transitions: { pairDrain: true, effects: { washout: true } } });
  queue.current = { track: { title: 'Live', artist: 'A', bpm: 120, musicalKey: '8A', duration: 250 } };
  const outgoing: QueueItem = { track: { title: 'Outgoing', artist: 'B', bpm: 120, musicalKey: '8A', duration: 250,
    washout: true } };
  const incoming: QueueItem = { track: { title: 'Incoming', artist: 'C', bpm: 120, musicalKey: '8A', duration: 250 } };
  queue.upcoming = [outgoing, incoming];
  queue.applyMixTransition(outgoing);
  assert.equal(outgoing.track.washout, true, 'outgoing gesture survives without DJ voice');
  assert.ok(typeof outgoing.track.crossSec === 'number' && outgoing.track.crossSec <= 10, 'operator crossfade ceiling remains authoritative');

  // Separate pair without an exit gesture, so pair-aware timing is eligible.
  const pairOut: QueueItem = { track: { title: 'Pair X', artist: 'X', bpm: 120, musicalKey: '8A', duration: 250 } };
  const pairIn: QueueItem = { track: { title: 'Pair Y', artist: 'Y', bpm: 120, musicalKey: '8A', duration: 250 } };
  queue.applyPairStamps(pairOut, pairIn);
  assert.ok(typeof pairOut.track.crossSec === 'number' && pairOut.track.crossSec >= 3 && pairOut.track.crossSec < 10,
    'a compatible pair gets a shorter stamped fade than the 10-second default');
});

test('without opt-in, silent persona retains legacy effect rejection and eager drain', async () => {
  process.env.SUBWAVE_MUSIC_MIXING_V1 = '0';
  const item: QueueItem = { track: { title: 'Disabled', artist: 'D', bpm: 120, musicalKey: '8A',
    duration: 240, washout: true } };
  queue.upcoming = [item];
  queue.applyMixTransition(item);
  assert.equal(item.track.washout, undefined);
  assert.equal(queue.pairDrainActive(), false);
});

test.after(() => {
  if (originalMixingFlag == null) delete process.env.SUBWAVE_MUSIC_MIXING_V1;
  else process.env.SUBWAVE_MUSIC_MIXING_V1 = originalMixingFlag;
  rmSync(stateDir, { recursive: true, force: true });
});
