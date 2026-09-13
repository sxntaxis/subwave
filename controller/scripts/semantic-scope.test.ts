import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

test('forward orchestrator uses one semantic scope cohort for every phase', () => {
  add('current-none');
  add('current-unresolved');
  add('stale-labelled');
  add('manual-labelled');
  db.upsertTrackTags('current-none', {
    moods: [], energy: null, source: SEMANTIC_SOURCE, confidence: null,
    promptHash: SEMANTIC_PROMPT_HASH, model: SEMANTIC_MODEL,
  });
  db.upsertTrackTags('current-unresolved', {
    moods: [], energy: null, source: SEMANTIC_SOURCE, confidence: null,
    promptHash: SEMANTIC_PROMPT_HASH, model: SEMANTIC_MODEL,
  });
  db.upsertTrackTags('stale-labelled', {
    moods: ['bright'], energy: null, source: 'llm', confidence: null,
    promptHash: 'old-prompt', model: 'old-model',
  });
  db.upsertTrackTags('manual-labelled', {
    moods: ['warm'], energy: null, source: 'manual', confidence: 1,
  });

  const scope = db.semanticScopeIds();
  assert.ok(scope.includes('stale-labelled'));
  assert.ok(!scope.includes('current-none'));
  assert.ok(!scope.includes('current-unresolved'));
  assert.ok(!scope.includes('manual-labelled'));
  assert.deepEqual(db.semanticScopeIds(2), scope.slice(0, 2));

  const orchestrator = readFileSync(
    fileURLToPath(new URL('../src/music/tag-library.ts', import.meta.url)),
    'utf8',
  );
  assert.match(orchestrator, /const forwardSemanticCohort = db\.semanticScopeIds\(/);
  assert.match(orchestrator, /targetUntagged: forwardSemanticCohort/);
  assert.match(orchestrator, /scopeIds: forwardSemanticCohort/);
  assert.match(orchestrator, /semanticTagIds\(forwardSemanticCohort, songs\)/);
  const forwardBranch = orchestrator.slice(
    orchestrator.indexOf('if (plan.forwardTag)'),
    orchestrator.indexOf("if (!embeddings.isAvailable())"),
  );
  assert.doesNotMatch(forwardBranch,
    /const allUntagged = db\.untaggedIds\(\)/);
});
