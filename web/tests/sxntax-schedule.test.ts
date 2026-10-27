import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveTakeover, programmeClock, programmeDay, programmeHour, WEEK_DAYS } from '../components/skins/sxntax/scheduleModel';
import type { SchedulePayload } from '../lib/types';

const data: SchedulePayload = {
  timezone: 'America/Costa_Rica',
  shows: [{ id: 'night', name: 'Night Shift', topic: 'Late selections', mood: 'night', personaId: 'host', guestPersonaIds: ['guest', 'deleted'] }],
  personas: [{ id: 'host', name: 'Host', avatar: '' }, { id: 'guest', name: 'Guest', avatar: '' }],
  schedule: { 3: Array.from({ length: 24 }, (_, hour) => hour < 6 || hour >= 20 ? 'night' : null) },
};

test('daily programme covers exactly 24 hours and keeps midnight-crossing runs in their own day', () => {
  const blocks = programmeDay(data, 3);
  assert.deepEqual(blocks.map(block => [block.start, block.end, block.name]), [[0, 6, 'Night Shift'], [6, 20, 'Freeform'], [20, 24, 'Night Shift']]);
  assert.equal(blocks[0]?.hosts, 'Host + Guest');
  assert.equal(blocks.reduce((sum, block) => sum + block.end - block.start, 0), 24);
  assert.deepEqual(WEEK_DAYS, [1, 2, 3, 4, 5, 6, 0]);
});

test('missing or deleted slots degrade to a continuous freeform programme', () => {
  assert.deepEqual(programmeDay(data, 4).map(block => [block.start, block.end, block.name]), [[0, 24, 'Freeform']]);
  const broken = { ...data, schedule: { 0: ['deleted', null, 'deleted'] } };
  assert.equal(programmeDay(broken, 0).length, 1);
});

test('the highlight follows the station clock across midnight, not the browser timezone', () => {
  assert.deepEqual(programmeClock(new Date('2026-10-22T02:35:00Z'), data.timezone), { day: 3, hour: 20, minute: 35, minutes: 1235 });
  assert.equal(programmeHour(24, 'en-GB'), '24:00');
  assert.equal(programmeHour(24, 'en-US'), '12:00 AM');
  assert.equal(programmeHour(13, 'en-US'), '1:00 PM');
});

test('only a valid, currently active takeover replaces the live weekly highlight', () => {
  const now = Date.parse('2026-10-21T18:00:00Z');
  const override = { showId: 'night', startedAt: now - 1000, expiresAt: now + 1000 };
  assert.equal(liveTakeover({ ...data, override }, now), override);
  assert.equal(liveTakeover({ ...data, override }, now + 1000), null);
  assert.equal(liveTakeover({ ...data, override }, now - 2000), null);
  assert.equal(liveTakeover({ ...data, override: { ...override, showId: 'deleted' } }, now), null);
  assert.ok(liveTakeover({ ...data, override: { ...override, showId: null } }, now), 'default-programming takeover is valid');
});
