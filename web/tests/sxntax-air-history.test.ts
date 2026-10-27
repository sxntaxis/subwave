import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAirHistory } from '../components/skins/sxntax/airHistory';
import type { SessionTurn, StationState } from '../lib/types';

const start = Date.parse('2026-10-21T12:00:00Z');
const iso = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const speech = (seconds: number, text: string): SessionTurn => ({
  role: 'segment', kind: 'link', text, t: iso(seconds),
  meta: { airedAt: iso(seconds), personaName: 'Previous DJ' },
});
const base: StationState = { upcoming: [], history: [], djLog: [] };

test('AIR includes NEXT, NOW and all 100 prior songs without speech consuming song slots', () => {
  const state: StationState = {
    ...base,
    current: { subsonic_id: 'now', title: 'Current song', reason: 'Current reason' },
    upcoming: [{ subsonic_id: 'next', title: 'Next song', reason: 'Next reason' }],
    history: Array.from({ length: 100 }, (_, i) => ({
      subsonic_id: `song-${i}`, title: `Song ${i}`, startedAt: iso(-i * 100), reason: `Reason ${i}`,
    })),
    airMessages: Array.from({ length: 150 }, (_, i) => speech(-i * 20, `Speech ${i}`)),
  };
  const air = buildAirHistory({ state, nowPlaying: state.current!, messages: [], leadMs: 0, nowMs: start + 100_000 });
  assert.equal(air.next?.title, 'Next song');
  assert.equal(air.nextReason, 'Next reason');
  assert.equal(air.current?.title, 'Current song');
  assert.equal(air.currentReason, 'Current reason');
  assert.equal(air.rows.filter(row => row.kind === 'track').length, 100);
  assert.equal(air.rows.filter(row => row.kind === 'voice').length, 150);
});

test('repeated songs keep each airing’s own reason after the session changes', () => {
  const state: StationState = {
    ...base, airMessages: [speech(0, 'An old-show comment')],
    current: { subsonic_id: 'repeat', title: 'Same song', reason: 'This airing' },
    history: [{ subsonic_id: 'repeat', title: 'Same song', startedAt: iso(-1000), reason: 'Earlier airing' }],
  };
  const air = buildAirHistory({ state, nowPlaying: state.current!, messages: [], leadMs: 0, nowMs: start });
  assert.equal(air.currentReason, 'This airing');
  assert.equal(air.rows.find(row => row.kind === 'track')?.reason, 'Earlier airing');
  const voice = air.rows.find(row => row.kind === 'voice');
  assert.equal(voice?.text, 'An old-show comment');
  assert.equal(voice?.speaker, 'Previous DJ');
});

test('the listener-time current song is not duplicated in history during metadata hold', () => {
  const audible = { subsonic_id: 'audible', title: 'Still audible', startedAt: iso(-100), queuedAt: iso(-200) };
  const state: StationState = {
    ...base, current: { subsonic_id: 'incoming', title: 'At live edge' },
    history: [audible, { subsonic_id: 'older', title: 'Earlier', startedAt: iso(-500) }],
  };
  const air = buildAirHistory({ state, nowPlaying: audible, messages: [], leadMs: 22_000, nowMs: start });
  assert.equal(air.current?.title, 'Still audible');
  assert.equal(air.rows.length, 1);
  assert.equal(air.rows[0]?.kind, 'track');
  assert.equal(air.rows[0]?.t, iso(-500));
});

test('speech is delayed only until audible, then remains available on a new page', () => {
  const state: StationState = { ...base, airMessages: [speech(0, 'Aired comment')] };
  const args = { state, nowPlaying: null, messages: [], leadMs: 22_000 };
  assert.equal(buildAirHistory({ ...args, nowMs: start + 10_000 }).rows.length, 0);
  assert.equal(buildAirHistory({ ...args, nowMs: start + 22_000 }).rows.length, 1);
  assert.equal(buildAirHistory({ ...args, nowMs: start + 86400_000 }).rows.length, 1);
});
