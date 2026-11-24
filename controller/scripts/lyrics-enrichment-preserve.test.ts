// SQL-level regression: a Navidrome lyric miss must not erase backfilled text.
// This calls the production writer through the in-memory library.db handle.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setHandle } from '../src/music/library-db/handle.js';
import { upsertTrackEnrichment } from '../src/music/library-db/tracks.js';

test('enrichment preserves existing lyrics on upstream miss and keeps explicit refresh behavior', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE tracks (
    id TEXT PRIMARY KEY, lastfm_tags TEXT, lyric_excerpt TEXT, enriched_at TEXT,
    moods TEXT, source TEXT
  );`);
  const add = db.prepare(`INSERT INTO tracks
    (id, lastfm_tags, lyric_excerpt, enriched_at, moods, source)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const oldLyrics = 'A verified verse about memory\nAnother independent lyrical context';
  add.run('existing', '["original"]', oldLyrics, '2026-01-01T00:00:00.000Z', '["warm"]', 'manual');
  add.run('missing', null, null, null, '["dark"]', 'llm');
  const read = db.prepare('SELECT * FROM tracks WHERE id = ?');
  setHandle({ db });
  try {
    // getLyrics() converts empty/error to NULL, including when previously hydrated.
    upsertTrackEnrichment('existing', { lastfmTags: ['refreshed'], lyricExcerpt: null });
    const preserved = read.get('existing') as Record<string, unknown>;
    assert.equal(preserved.lyric_excerpt, oldLyrics);
    assert.equal(preserved.lastfm_tags, '["refreshed"]');
    assert.notEqual(preserved.enriched_at, '2026-01-01T00:00:00.000Z');
    assert.equal(preserved.moods, '["warm"]');
    assert.equal(preserved.source, 'manual');

    // A confirmed new lyric still refreshes; --re-enrich is not silently disabled.
    const newLyrics = 'A legitimately refreshed original lyric body from Navidrome';
    upsertTrackEnrichment('existing', { lastfmTags: null, lyricExcerpt: newLyrics });
    assert.equal((read.get('existing') as Record<string, unknown>).lyric_excerpt, newLyrics);

    // Missing lyrics remain NULL on a miss, then accept the next valid fetch.
    upsertTrackEnrichment('missing', { lastfmTags: null, lyricExcerpt: null });
    assert.equal((read.get('missing') as Record<string, unknown>).lyric_excerpt, null);
    upsertTrackEnrichment('missing', { lastfmTags: null, lyricExcerpt: oldLyrics });
    const hydrated = read.get('missing') as Record<string, unknown>;
    assert.equal(hydrated.lyric_excerpt, oldLyrics);
    assert.equal(hydrated.moods, '["dark"]');
    assert.equal(hydrated.source, 'llm');
  } finally {
    setHandle({ db: null });
    db.close();
  }
});
