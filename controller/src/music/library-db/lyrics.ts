// Read-only lyric discovery against the existing tracks.lyric_excerpt column.
// No migration, FTS index or new store. Scans happen only on explicit thematic
// requests / tool calls, not on the autonomous per-song queue hot path.
import { requireDb } from './handle.js';

export interface LyricSearchRow { id: string; title: string | null; artist: string | null; lyric_excerpt: string; }

export function searchStoredLyrics(terms: readonly string[], limit = 1200): LyricSearchRow[] {
  const needles = [...new Set(terms.filter(t => t.length >= 3))].slice(0, 24);
  if (!needles.length) return [];
  // instr() avoids LIKE wildcards and parameter escaping ambiguity. Casefold
  // is a prefilter only; actual Unicode-aware, whole-token checks are in JS.
  const where = needles.map(() => 'instr(lower(lyric_excerpt), ?) > 0').join(' OR ');
  return requireDb().prepare(`SELECT id, title, artist, lyric_excerpt FROM tracks WHERE lyric_excerpt IS NOT NULL AND length(lyric_excerpt) >= 24 AND (${where}) LIMIT ?`)
    .all(...needles, Math.max(1, Math.min(limit, 1500))) as LyricSearchRow[];
}

export function readStoredLyrics(ids: readonly string[]): LyricSearchRow[] {
  const unique = [...new Set(ids.filter(Boolean))].slice(0, 80);
  if (!unique.length) return [];
  const marks = unique.map(() => '?').join(',');
  return requireDb().prepare(`SELECT id, title, artist, lyric_excerpt FROM tracks WHERE id IN (${marks}) AND lyric_excerpt IS NOT NULL`)
    .all(...unique) as LyricSearchRow[];
}
