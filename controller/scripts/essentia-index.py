#!/usr/bin/env python3
"""Incrementally project committed sidecar segments into an independent index.

Never writes to the source. Run as the sidecar owner with low CPU/IO priority.
Each invocation processes at most --limit segments and holds no long read
transaction. Partial analyses are never marked ready.
"""
import argparse
import fcntl
import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path

HEADS = {
    'deam-msd-musicnn-2': ('deam', {'arousal', 'valence'}, 1, 9),
    'danceability-discogs-effnet-1': ('binary', {'danceable'}, 0, 1),
    'voice_instrumental-discogs-effnet-1': ('binary', {'voice'}, 0, 1),
    'timbre-discogs-effnet-1': ('binary', {'bright'}, 0, 1),
    'mtg_jamendo_moodtheme-discogs-effnet-1': ('moods', None, 0, 1),
    'mtg_jamendo_instrument-discogs-effnet-1': ('instruments', None, 0, 1),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS cursor_state (id INTEGER PRIMARY KEY CHECK(id=1), segment_id INTEGER NOT NULL);
INSERT OR IGNORE INTO cursor_state VALUES (1, 0);
CREATE TABLE IF NOT EXISTS evidence (
 analysis_id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, source_path TEXT NOT NULL,
 source_size INTEGER NOT NULL, source_mtime_ns INTEGER NOT NULL,
 expected_segments INTEGER NOT NULL, indexed_segments INTEGER NOT NULL,
 sums_json TEXT NOT NULL, counts_json TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS evidence_track ON evidence(track_id, ready);
CREATE INDEX IF NOT EXISTS evidence_ready ON evidence(ready);
CREATE TABLE IF NOT EXISTS trait_value (
 analysis_id INTEGER NOT NULL, trait TEXT NOT NULL, value REAL NOT NULL,
 PRIMARY KEY (analysis_id, trait)
);
CREATE INDEX IF NOT EXISTS trait_rank ON trait_value(trait, value, analysis_id);
CREATE TABLE IF NOT EXISTS index_contract (id INTEGER PRIMARY KEY CHECK(id=1), models_sha256 TEXT NOT NULL, version INTEGER NOT NULL);
"""


def models_hash(models):
    return hashlib.sha256(json.dumps(models, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def ensure_contract(target, models):
    digest = models_hash(models)
    existing = target.execute('SELECT models_sha256,version FROM index_contract WHERE id=1').fetchone()
    if existing is None:
        if target.execute('SELECT count(*) FROM evidence').fetchone()[0]:
            raise ValueError('existing index lacks provenance contract; use a new index')
        with target:
            target.execute('INSERT INTO index_contract VALUES (1,?,2)', (digest,))
    elif existing != (digest, 2):
        raise ValueError('index provenance contract mismatch')


def trusted_runs(source, models):
    trusted = set()
    for run_id, version, provenance in source.execute('SELECT run_id,code_version,provenance_json FROM analysis_run'):
        try:
            meta = json.loads(provenance)
            if (version == 'essentia-window-v1' and meta.get('models') == models
                    and meta.get('sample_rate') == 16000
                    and meta.get('window_policy') == 'up to five non-overlapping 10s windows: start, quartiles, end'
                    and meta.get('inference_aggregation') == 'mean over model patches per segment'):
                trusted.add(run_id)
        except (TypeError, ValueError, AttributeError):
            continue
    return trusted


def write_ready_marker(target, path, models):
    ready = target.execute('SELECT 1 FROM evidence WHERE ready=1 LIMIT 1').fetchone() is not None
    data = {'version': 2, 'models_sha256': models_hash(models), 'ready': ready,
            'updated_ms': round(time.time() * 1000)}
    marker = Path(str(path) + '.ready')
    temp = Path(str(marker) + '.tmp')
    with open(temp, 'w', encoding='utf-8') as out:
        json.dump(data, out, separators=(',', ':'))
    os.replace(temp, marker)


def advance(source, target, limit, models):
    """Advance over at most limit committed segments; return count examined."""
    ensure_contract(target, models)
    trusted = trusted_runs(source, models)
    cursor = target.execute('SELECT segment_id FROM cursor_state WHERE id=1').fetchone()[0]
    segments = source.execute(
        'SELECT segment_id,analysis_id FROM track_segment WHERE segment_id>? ORDER BY segment_id LIMIT ?',
        (cursor, limit)).fetchall()
    for segment_id, analysis_id in segments:
        # The worker commits a track's segments and analysis in one transaction.
        row = source.execute(
            'SELECT a.track_id,a.source_size,a.source_mtime_ns,a.summary_json,i.source_path,a.run_id '
            'FROM track_analysis a JOIN source_inventory i ON i.track_id=a.track_id '
            "WHERE a.analysis_id=? AND a.status='complete' AND i.nav_missing=0 AND i.path_status='mapped'",
            (analysis_id,)).fetchone()
        predictions = source.execute(
            'SELECT model_id,class_name,raw_score,native_scale,missing_reason '
            'FROM model_prediction WHERE segment_id=?', (segment_id,)).fetchall()
        with target:
            if row:
                track_id, size, mtime, summary, path, run_id = row
                try:
                    count = json.loads(summary)['segments']
                    st = os.stat(path)
                    fresh = (run_id in trusted and isinstance(count, int) and 1 <= count <= 5
                             and size == st.st_size and mtime == st.st_mtime_ns)
                except (OSError, TypeError, KeyError, ValueError, json.JSONDecodeError):
                    fresh = False
                if fresh:
                    old = target.execute(
                        'SELECT indexed_segments,sums_json,counts_json FROM evidence WHERE analysis_id=?',
                        (analysis_id,)).fetchone()
                    n, sums, counts = (old[0], json.loads(old[1]), json.loads(old[2])) if old else (0, {}, {})
                    for model, label, value, scale, missing in predictions:
                        spec = HEADS.get(model)
                        if not spec or missing or not isinstance(value, (int, float)):
                            continue
                        group, allowed, low, high = spec
                        if allowed is not None and label not in allowed:
                            continue
                        if not isinstance(label, str) or len(label) > 64 or not low <= value <= high:
                            continue
                        if group == 'deam' and scale != 'DEAM native [1,9], valence then arousal':
                            continue
                        if group != 'deam' and scale != 'model native; see metadata':
                            continue
                        key = group + ':' + label
                        sums[key] = sums.get(key, 0) + value
                        counts[key] = counts.get(key, 0) + 1
                    n += 1
                    target.execute(
                        'INSERT OR REPLACE INTO evidence VALUES (?,?,?,?,?,?,?,?,?,?)',
                        (analysis_id, track_id, path, size, mtime, count, n,
                         json.dumps(sums, separators=(',', ':')), json.dumps(counts, separators=(',', ':')),
                         int(n == count)))
                    if n == count:
                        for key, total in sums.items():
                            if counts[key] == count:
                                target.execute('INSERT OR REPLACE INTO trait_value VALUES (?,?,?)',
                                               (analysis_id, key, total / count))
            target.execute('UPDATE cursor_state SET segment_id=? WHERE id=1', (segment_id,))
    return len(segments)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--index', required=True)
    parser.add_argument('--models-manifest', required=True)
    parser.add_argument('--limit', type=int, default=20)
    parser.add_argument('--follow', action='store_true',
                        help='continue in bounded batches as new segments arrive')
    parser.add_argument('--interval', type=int, default=10)
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        parser.error('limit must be between 1 and 100')
    if not 5 <= args.interval <= 3600:
        parser.error('interval must be between 5 and 3600 seconds')
    os.umask(0o077)
    source_path = Path(args.source).resolve()
    index_path = Path(args.index).resolve()
    if source_path == index_path:
        parser.error('index must be independent of the source')
    with open(args.models_manifest, encoding='utf-8') as manifest:
        models = json.load(manifest)['models']
    if not isinstance(models, dict) or not models:
        parser.error('models manifest is empty or invalid')
    # A second indexer could advance the same cursor from stale state.
    lock_path = str(index_path) + '.lock'
    if Path(lock_path).resolve() == source_path:
        parser.error('lock must be independent of the source')
    with open(lock_path, 'a', encoding='utf-8') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('indexer already running')
        source = sqlite3.connect(source_path.as_uri() + '?mode=ro', uri=True, timeout=0.1)
        source.execute('PRAGMA query_only=ON')
        target = sqlite3.connect(index_path, timeout=0.1)
        target.executescript(SCHEMA)
        try:
            while True:
                try:
                    examined = advance(source, target, args.limit, models)
                    write_ready_marker(target, index_path, models)
                    if not args.follow:
                        print('segments examined:', examined)
                        break
                except sqlite3.OperationalError:
                    # A writer may briefly hold a lock. A later pass retries the
                    # last committed cursor; never block a station component.
                    if not args.follow:
                        raise
                time.sleep(args.interval)
        finally:
            target.close()
            source.close()


if __name__ == '__main__':
    main()
