import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIR_HISTORY_TRACKS, airMessage, recoverAirMessages, retainAirMessages } from '../src/broadcast/air-history.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-air-history-'));
process.env.STATE_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));
const start = Date.now() - 3600_000;
const iso = (offset: number) => new Date(start + offset).toISOString();
const segment = (offset: number, text = `Speech ${offset}`) => ({
  t: iso(offset), role: 'segment', kind: 'link', text,
  meta: { airedAt: iso(offset), personaName: 'Earlier host', privatePrompt: 'not public' },
});

test('speech retention follows songs, without the old 12-row or 120-turn cuts', () => {
  const messages = Array.from({ length: 150 }, (_, i) => segment(i * 1000));
  const kept = retainAirMessages([...messages, messages[0], { role: 'event', text: 'private pick prompt' }], start);
  assert.equal(kept.length, 150);
  assert.equal(kept[0].text, 'Speech 0');
  assert.equal('privatePrompt' in kept[0].meta, false);
  assert.equal(retainAirMessages(messages, start + 50_000).length, 100);
  assert.equal(airMessage({ ...segment(0), t: 'invalid' }), null);
  assert.equal(airMessage({ ...segment(0), kind: 'sfx' }), null);
  assert.equal(airMessage({ ...segment(0), kind: 'jingle' }), null);
});

test('an upgrade restores aired speech from past shows and the current session', () => {
  const dir = join(root, 'archives');
  mkdirSync(dir);
  const currentFile = join(root, 'current.json');
  writeFileSync(join(dir, 'sess_aabb.json'), JSON.stringify({
    persona: { name: 'Previous host' }, messages: [
      { ...segment(10_000), meta: {} },
      { t: iso(11_000), role: 'dj', kind: 'pick', text: 'not aired speech' },
      { t: iso(12_000), role: 'event', kind: 'pick', text: 'private system prompt' },
    ],
  }));
  writeFileSync(join(dir, 'sess_ccdd.json'), '{ damaged archive');
  writeFileSync(currentFile, JSON.stringify({ messages: [segment(20_000)] }));
  const recovered = recoverAirMessages(currentFile, dir, start);
  assert.equal(recovered.length, 2);
  assert.equal(recovered[0].meta.personaName, 'Previous host');
  assert.equal(recovered[1].meta.personaName, 'Earlier host');
});

test('queue recovery retains 100 songs and their per-airing reasons', async () => {
  const { config } = await import('../src/config.js');
  const { queue } = await import('../src/broadcast/queue.js');
  const history = Array.from({ length: 105 }, (_, i) => ({
    track: { id: `song-${i}`, title: `Song ${i}` },
    startedAt: iso(300_000 - i * 1000), aiPicked: true, intent: `Reason ${i}`,
  }));
  writeFileSync(config.queue.file, JSON.stringify({ history, upcoming: [], airMessages: [segment(250_000)] }));
  queue.recover();
  const snap = queue.snapshot();
  assert.equal(snap.history.length, AIR_HISTORY_TRACKS);
  assert.equal(snap.history[99].reason, 'Reason 99');
  assert.equal(snap.airMessages[0].text, 'Speech 250000');

  // The real post-air hook, not generation or a connected browser, saves speech.
  let resolveAir!: (at: number) => void;
  const aired = new Promise<number>(resolve => { resolveAir = resolve; });
  queue.onSpoken({ voiceId: 'air-history-test', clipMs: 1000, aired }, {
    kind: 'link', channel: 'intro', text: 'Retained across the next show.',
    persona: { name: 'Original host' },
  });
  assert.equal(queue.airMessages.length, 1, 'not saved before it airs');
  resolveAir(Date.now());
  await aired;
  await new Promise(resolve => setTimeout(resolve, 650));
  const stored = JSON.parse(readFileSync(config.queue.file, 'utf8'));
  assert.equal(stored.airMessages.at(-1).text, 'Retained across the next show.');
  assert.equal(stored.airMessages.at(-1).meta.personaName, 'Original host');
  queue.airMessages = [];
  queue.recover();
  assert.equal(queue.snapshot().airMessages.at(-1)?.text, 'Retained across the next show.');
});
