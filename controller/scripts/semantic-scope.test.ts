import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-semantic-scope-'));

const db = await import('../src/music/library-db.js');
const {
  SEMANTIC_MODEL,
  SEMANTIC_PROMPT_HASH,
  SEMANTIC_SOURCE,
  SEMANTIC_MOOD_IDS,
} = await import('../src/music/semantic/contract-v2.js');

await db.open({ embeddingDim: 768, adoptStoredDim: true });

function add(id: string) {
  db.upsertTrackMeta(id, { title: id, artist: 'Artist', album: 'Album' });
}

test('semantic authority exposes the fixed canonical order', () => {
  assert.deepEqual(SEMANTIC_MOOD_IDS, ['serene', 'warm', 'bright', 'playful', 'bittersweet', 'melancholic', 'dark', 'tense', 'wonder']);
});

test('scope selects stale machine rows but skips manual and current semantic rows', () => {
  add('legacy');
  add('manual');
  add('current');
  db.upsertTrackTags('legacy', {
    moods: ['calm'], energy: 'high', source: 'llm', confidence: null,
    promptHash: 'legacy-prompt', model: 'legacy-model',
  });
  db.upsertTrackTags('manual', {
    moods: ['warm'], energy: 'low', source: 'manual', confidence: 1,
  });
  db.upsertTrackTags('current', {
    moods: [], energy: 'medium', source: SEMANTIC_SOURCE, confidence: null,
    promptHash: SEMANTIC_PROMPT_HASH, model: SEMANTIC_MODEL,
  });

  assert.deepEqual(db.semanticScopeIds(), ['legacy']);
  assert.deepEqual(db.currentSemanticIds(), ['current']);
  assert.equal(db.semanticProcessedCount(), 1);
  assert.equal(db.semanticLabelCount(), 0);
  assert.equal(db.getTrack('current')?.energy, 'medium');
});
