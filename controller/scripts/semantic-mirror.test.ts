import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-semantic-mirror-'));

const db = await import('../src/music/library-db.js');
const { persistCanonicalSemanticResult } = await import('../src/music/tag-library/semantic.js');
const { SEMANTIC_MODEL, SEMANTIC_PROMPT_HASH, SEMANTIC_SOURCE } = await import('../src/music/semantic/contract-v2.js');

await db.open({ embeddingDim: 768, adoptStoredDim: true });

function add(id: string) {
  db.upsertTrackMeta(id, { title: id, artist: 'Artist', album: 'Album' });
}

test('labels completion writes canonical currentness and excludes the row from scope', () => {
  add('labels');
  assert.equal(persistCanonicalSemanticResult('labels', { outcome: 'SEMANTIC_LABELS', moods: ['warm', 'bright'] }), 'labels');
  assert.equal(db.semanticScopeIds().includes('labels'), false);
  assert.deepEqual(db.getTrack('labels')?.moods, ['warm', 'bright']);
  assert.equal(db.getTrack('labels')?.source, SEMANTIC_SOURCE);
  assert.equal(db.getTrack('labels')?.promptHash, SEMANTIC_PROMPT_HASH);
  assert.equal(db.getTrack('labels')?.model, SEMANTIC_MODEL);
  assert.ok(db.getTrack('labels')?.taggedAt);
});

test('NONE completion writes empty moods and canonical currentness', () => {
  add('none');
  assert.equal(persistCanonicalSemanticResult('none', { outcome: 'SEMANTIC_NONE', moods: [] }), 'none');
  assert.equal(db.semanticScopeIds().includes('none'), false);
  assert.deepEqual(db.getTrack('none')?.moods, []);
});

test('UNRESOLVED completion writes empty moods and canonical currentness', () => {
  add('unresolved');
  assert.equal(persistCanonicalSemanticResult('unresolved', { outcome: 'UNRESOLVED_INSUFFICIENT_EVIDENCE' }), 'unresolved');
  assert.equal(db.semanticScopeIds().includes('unresolved'), false);
  assert.deepEqual(db.getTrack('unresolved')?.moods, []);
});

test('recovered existing labels result uses the same canonical path as normal completion', () => {
  add('recovered');
  db.setTrackEditorialMoods('recovered', ['warm', 'bright', 'playful']);
  assert.equal(db.semanticScopeIds().includes('recovered'), true, 'moods-only recovery must remain pending');
  assert.equal(persistCanonicalSemanticResult('recovered', {
    outcome: 'SEMANTIC_LABELS',
    moods: ['warm', 'bright', 'playful'],
  }), 'labels');
  assert.equal(db.semanticScopeIds().includes('recovered'), false);
  assert.deepEqual(db.getTrack('recovered')?.moods, ['warm', 'bright', 'playful']);
});
