// Operator-invoked read-only fixture. Takes explicit paths; never prints tracks.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createAcousticIndex } from '../src/music/library-db/acoustic-index.js';
import { applyStrictLocks } from '../src/music/show-filter.js';
import { mergePlaylistTracks } from '../src/music/show-playlist.js';
import { isStationArchive } from '../src/music/subsonic.js';
import { buildPickerContext, pickerScope } from '../src/llm/internal/tools/picker/scope.js';
import playlistTool from '../src/llm/internal/tools/picker/tools/show-playlist-tracks.js';
import assert from 'node:assert/strict';

async function main() {
  const [schedulePath, navPath, mirrorPath] = process.argv.slice(2);
  if (!schedulePath || !navPath || !mirrorPath) throw new Error('pass schedule, Navidrome DB and mirror DB paths');
  const schedule = JSON.parse(readFileSync(schedulePath, 'utf8'));
  const nav = new Database(navPath, { readonly: true, fileMustExist: true });
  const mirror = new Database(mirrorPath, { readonly: true, fileMustExist: true });
  const index = createAcousticIndex(mirrorPath);
  try {
    const ready = await index.whenReady(120000);
    if (!ready) throw new Error('index unavailable');
    const get = mirror.prepare('SELECT id,title,artist,genres,duration_sec AS duration FROM tracks WHERE id=?');
    const members = nav.prepare('SELECT m.id,m.path,m.title,m.artist FROM playlist_tracks p JOIN media_file m ON m.id=p.media_file_id WHERE p.playlist_id=? ORDER BY p.id');
    const all = mirror.prepare('SELECT id,title,artist,genres,duration_sec AS duration FROM tracks WHERE duration_sec > 120 ORDER BY id').all() as any[];
    const norm = (row: any) => ({ ...row, genres: JSON.parse(row.genres || '[]') });
    for (const id of ['s_housebrew', 's_atmospheres', 's_funkplay', 's_distorted']) {
      const show = schedule.shows.find((s: any) => s.id === id);
      if (!show) throw new Error(`missing show ${id}`);
      let pool: any[], missing = 0;
      if (show.playlistIds?.length) {
        const lists = show.playlistIds.map((p: string) => members.all(p).filter((x: any) => !isStationArchive(x)));
        pool = mergePlaylistTracks(lists).map((x: any) => {
          const item = get.get(x.id); if (!item) missing++; return item;
        }).filter(Boolean).map(norm);
      } else pool = all.map(norm);
      const eligible = applyStrictLocks(pool, { genres: show.genres, eras: show.eras,
        moods: show.moods, energies: show.energies, vocals: show.vocals }, { starve: true });
      const source = eligible.filter((x: any) => x.duration > 120);
      if (source.length < 2) { console.log(JSON.stringify({ id, unavailable: true, missing })); continue; }
      // Derived from the entire independently filtered show pool, never from
      // the sampled candidates passed to the tool.
      const authoritative = new Set(source.map((x: any) => x.id));
      const lock = new Set(pool.map((x: any) => x.id));
      for (const seed of [771, 991, 2027]) {
      let sampleState = seed;
      const sample = source.map((value: any) => {
        sampleState = sampleState * 16807 % 2147483647;
        return { value, rank: sampleState };
      }).sort((a: any, b: any) => a.rank - b.rank).slice(0, 65).map((x: any) => x.value);
      const anchor = sample[0].id, candidates = sample.slice(1);
      const negative = all.map(norm).find((x: any) => !authoritative.has(x.id));
      assert.ok(negative && !authoritative.has(negative.id), 'negative control must be outside the independent show set');
      async function run(on: boolean) {
        const ctx = buildPickerContext(pickerScope({ playlistTracks: candidates,
          ...(show.playlistStrict ? { playlistLock: lock } : {}),
          genreLock: show.genres, ...(on ? { selection: { predecessorId: anchor, recentAiredIds: [] } } : {}) }),
        async (ids, timeout) => index.lookup(ids, timeout));
        let state = seed; const old = Math.random;
        Math.random = () => { state = state * 16807 % 2147483647; return (state - 1) / 2147483646; };
        try {
          const t = performance.now();
          const tool = playlistTool.build(ctx) as any;
          const result = await tool.execute({}, { toolCallId: 'offline', messages: [] });
          if (!Array.isArray(result)) throw new Error('empty tool result');
          return { ids: result.map((x: any) => x.id), artists: new Set(result.map((x: any) => x.artist)).size,
            seen: [...ctx.seen.keys()], ms: performance.now() - t };
        } finally { Math.random = old; }
      }
      const off = await run(false), on = await run(true);
      assert.ok([...off.ids, ...on.ids].every((x: string) => authoritative.has(x)), 'show hard eligibility violated');
      assert.deepEqual(off.ids, off.seen); assert.deepEqual(on.ids, on.seen);
      console.log(JSON.stringify({ id, seed, source: candidates.length, strictLock: show.playlistStrict ? lock.size : null, rawPool: pool.length, missing,
        eligible: eligible.length, off: off.ids.length, on: on.ids.length,
        changed: on.ids.filter((x: string) => !off.ids.includes(x)).length,
        violations: on.ids.filter((x: string) => !authoritative.has(x)).length,
        seenMatches: JSON.stringify(on.ids) === JSON.stringify(on.seen),
        offArtists: off.artists, onArtists: on.artists, offMs: off.ms, onMs: on.ms,
        provenance: 'offline hypothetical anchor; DB-backed playlist membership, not Subsonic API' }));
      }
    }
  } finally { index.close(); mirror.close(); nav.close(); }
}
void main();
