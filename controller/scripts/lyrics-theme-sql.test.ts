// Uses the existing library.db handle contract, without modifying any disk DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setHandle } from '../src/music/library-db/handle.js';
import { searchStoredLyrics, readStoredLyrics } from '../src/music/library-db/lyrics.js';

test('stored lyrics lexical lookup reads lyrics, never genre-only matches', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT, artist TEXT, lyric_excerpt TEXT);');
  const add = db.prepare('INSERT INTO tracks (id,title,artist,lyric_excerpt) VALUES (?,?,?,?)');
  add.run('a', 'One', 'Reggae Example', 'We grow ganja under the sun.\nGanja grows in our garden every day.');
  add.run('b', 'Cannabis Dreams', 'Reggae Example', 'The sun shines over the waves all day long.');
  add.run('c', 'Third', 'Another Example', null);
  setHandle({ db });
  try {
    const rows = searchStoredLyrics(['ganja', 'cannabis']);
    assert.deepEqual(rows.map(r => r.id), ['a']);
    assert.equal(readStoredLyrics(['a','b','missing']).length, 2);
  } finally {
    setHandle({ db: null });
    db.close();
  }
});
