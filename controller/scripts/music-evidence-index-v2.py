#!/usr/bin/env python3
"""Build the additive Music Evidence v2 projection from the worker-owned DB.

The source is opened query-only; a separate index owns the cursor and projection.
No audio is decoded and no source database, inventory or file is modified.
"""
import argparse
import fcntl
import importlib.util
import json
import math
import os
from pathlib import Path
import sqlite3
import time

_spec = importlib.util.spec_from_file_location('essentia_index_v1', Path(__file__).with_name('essentia-index.py'))
_v1 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_v1)

VERSION = 3  # v1's independent projection already uses index contract version 2.
SCHEMA = """
CREATE TABLE IF NOT EXISTS contract (id INTEGER PRIMARY KEY CHECK(id=1),
  version INTEGER NOT NULL, models_sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cursor_state (id INTEGER PRIMARY KEY CHECK(id=1),
  segment_id INTEGER NOT NULL);
INSERT OR IGNORE INTO cursor_state VALUES (1,0);
CREATE TABLE IF NOT EXISTS evidence (
  analysis_id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, run_id TEXT NOT NULL,
  source_path TEXT NOT NULL, source_size INTEGER NOT NULL, source_mtime_ns INTEGER NOT NULL,
  expected_windows INTEGER NOT NULL, indexed_windows INTEGER NOT NULL DEFAULT 0,
  provenance_json TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS evidence_identity ON evidence(track_id,ready);
CREATE TABLE IF NOT EXISTS windows (
  segment_id INTEGER PRIMARY KEY, analysis_id INTEGER NOT NULL, start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL, role TEXT NOT NULL, measurements_json TEXT, quality_json TEXT
);
CREATE INDEX IF NOT EXISTS windows_analysis ON windows(analysis_id,start_ms);
CREATE TABLE IF NOT EXISTS outputs (
  segment_id INTEGER NOT NULL, model_id TEXT NOT NULL, class_name TEXT NOT NULL,
  raw_score REAL, native_scale TEXT, missing_reason TEXT, validity TEXT NOT NULL,
  PRIMARY KEY(segment_id,model_id,class_name)
);
CREATE INDEX IF NOT EXISTS outputs_head ON outputs(model_id,class_name,segment_id);
CREATE TABLE IF NOT EXISTS head_summary (
  analysis_id INTEGER NOT NULL, model_id TEXT NOT NULL, class_name TEXT NOT NULL,
  mean REAL, minimum REAL, maximum REAL, valid_windows INTEGER NOT NULL,
  expected_windows INTEGER NOT NULL, PRIMARY KEY(analysis_id,model_id,class_name)
);
CREATE INDEX IF NOT EXISTS head_summary_search ON head_summary(model_id,class_name,analysis_id);
"""

# Covers the mean used by global joint ranking. This is intentionally NOT part
# of SCHEMA: adding it there would silently build ~200 MiB on an existing live
# projection whenever its ordinary follow-mode indexer restarts. Instead, new
# projections get it while empty; populated projections require an explicit,
# one-time, offline/maintenance opt-in below.
COVERING_INDEX_SQL = (
    'CREATE INDEX IF NOT EXISTS head_summary_search_cover '
    'ON head_summary(model_id,class_name,analysis_id,mean)'
)


def contract(target, models):
    digest = _v1.models_hash(models)
    row = target.execute('SELECT version,models_sha256 FROM contract WHERE id=1').fetchone()
    if row is None:
        if target.execute('SELECT count(*) FROM evidence').fetchone()[0]:
            raise ValueError('unversioned evidence index')
        with target:
            target.execute('INSERT INTO contract VALUES(1,?,?)', (VERSION, digest))
    elif row != (VERSION, digest):
        raise ValueError('evidence index contract mismatch')
    return digest


def validity(model, value, scale, missing):
    if missing:
        return 'source_missing'
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        return 'invalid_number'
    if model == 'deam-msd-musicnn-2':
        if scale != 'DEAM native [1,9], valence then arousal':
            return 'unrecognized_scale'
        if not 1 <= value <= 9:
            return 'outside_declared_range'
    elif model in {
        'danceability-discogs-effnet-1', 'voice_instrumental-discogs-effnet-1',
        'timbre-discogs-effnet-1', 'mtg_jamendo_moodtheme-discogs-effnet-1',
        'mtg_jamendo_instrument-discogs-effnet-1',
    }:
        if scale != 'model native; see metadata':
            return 'unrecognized_scale'
        if not 0 <= value <= 1:
            return 'outside_declared_range'
    elif model not in {'approachability_regression-discogs-effnet-1', 'engagement_regression-discogs-effnet-1'}:
        return 'unrecognized_head'
    return 'valid'


def advance(source, target, limit, models):
    contract(target, models)
    trusted = _v1.trusted_runs(source, models)
    cursor = target.execute('SELECT segment_id FROM cursor_state WHERE id=1').fetchone()[0]
    segments = source.execute(
        'SELECT segment_id,analysis_id,start_ms,end_ms,role,measurements_json,quality_json '
        'FROM track_segment WHERE segment_id>? ORDER BY segment_id LIMIT ?', (cursor, limit)
    ).fetchall()
    for segment in segments:
        sid, aid, start, end, role, measurements, quality = segment
        row = source.execute(
            'SELECT a.track_id,a.source_size,a.source_mtime_ns,a.summary_json,i.source_path,'
            'a.run_id,r.provenance_json FROM track_analysis a '
            'JOIN source_inventory i ON i.track_id=a.track_id '
            'JOIN analysis_run r ON r.run_id=a.run_id '
            "WHERE a.analysis_id=? AND a.status='complete' AND i.nav_missing=0 AND i.path_status='mapped'",
            (aid,),
        ).fetchone()
        with target:
            if row:
                track, size, mtime, summary, path, run, provenance = row
                try:
                    expected = json.loads(summary)['segments']
                    st = os.stat(path)
                    valid = (run in trusted and isinstance(expected, int) and 1 <= expected <= 5
                             and size == st.st_size and mtime == st.st_mtime_ns
                             and isinstance(start, int) and isinstance(end, int) and 0 <= start < end
                             and role in ('opening', 'body', 'ending'))
                except (OSError, TypeError, KeyError, ValueError, json.JSONDecodeError):
                    valid = False
                if valid:
                    target.execute(
                        'INSERT OR IGNORE INTO evidence(analysis_id,track_id,run_id,source_path,source_size,'
                        'source_mtime_ns,expected_windows,provenance_json) VALUES(?,?,?,?,?,?,?,?)',
                        (aid, track, run, path, size, mtime, expected, provenance),
                    )
                    target.execute('INSERT OR IGNORE INTO windows VALUES(?,?,?,?,?,?,?)',
                                   (sid, aid, start, end, role, measurements, quality))
                    outputs = source.execute(
                        'SELECT model_id,class_name,raw_score,native_scale,missing_reason '
                        'FROM model_prediction WHERE segment_id=?', (sid,),
                    ).fetchall()
                    for model, label, value, scale, missing in outputs:
                        target.execute('INSERT OR IGNORE INTO outputs VALUES(?,?,?,?,?,?,?)',
                                       (sid, model, label, value, scale, missing,
                                        validity(model, value, scale, missing)))
                    n = target.execute('SELECT count(*) FROM windows WHERE analysis_id=?', (aid,)).fetchone()[0]
                    target.execute('UPDATE evidence SET indexed_windows=?,ready=? WHERE analysis_id=?',
                                   (n, int(n == expected), aid))
                    if n == expected:
                        target.execute(
                            'INSERT OR REPLACE INTO head_summary '
                            'SELECT ?,o.model_id,o.class_name,'
                            "CASE WHEN sum(o.validity='valid')=? THEN avg(CASE WHEN o.validity='valid' THEN o.raw_score END) END,"
                            "min(CASE WHEN o.validity='valid' THEN o.raw_score END),"
                            "max(CASE WHEN o.validity='valid' THEN o.raw_score END),"
                            "sum(o.validity='valid'),? FROM outputs o "
                            'JOIN windows w ON w.segment_id=o.segment_id WHERE w.analysis_id=? '
                            'GROUP BY o.model_id,o.class_name',
                            (aid, expected, expected, aid),
                        )
            target.execute('UPDATE cursor_state SET segment_id=? WHERE id=1', (sid,))
    return len(segments)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--index', required=True)
    parser.add_argument('--models-manifest', required=True)
    parser.add_argument('--limit', type=int, default=20)
    parser.add_argument('--follow', action='store_true')
    parser.add_argument('--interval', type=int, default=10)
    parser.add_argument('--install-covering-index', action='store_true')
    args = parser.parse_args()
    if args.install_covering_index and args.follow:
        parser.error('covering-index installation must not run in follow mode')
    if not 1 <= args.limit <= 100 or not 5 <= args.interval <= 3600:
        parser.error('invalid batch or interval')
    os.umask(0o077)
    source_path, target_path = Path(args.source).resolve(), Path(args.index).resolve()
    if args.install_covering_index and not target_path.is_file():
        parser.error('existing v3 projection required for covering-index retrofit')
    if source_path == target_path:
        parser.error('index must be independent of source')
    models = json.loads(Path(args.models_manifest).read_text())['models']
    if not isinstance(models, dict) or not models:
        parser.error('invalid model manifest')
    with open(str(target_path) + '.lock', 'a', encoding='utf8') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('indexer already running')
        source = sqlite3.connect(source_path.as_uri() + '?mode=ro', uri=True, timeout=0.1)
        source.execute('PRAGMA query_only=ON')
        target = sqlite3.connect(target_path, timeout=0.1)
        try:
            if args.install_covering_index:
                # Reject wrong or uninitialized targets before any DDL. A
                # dedicated operator action is required for populated indexes.
                actual = target.execute(
                    'SELECT version,models_sha256 FROM contract WHERE id=1'
                ).fetchone()
                if actual != (VERSION, _v1.models_hash(models)):
                    raise ValueError('evidence index contract mismatch')
                target.execute(COVERING_INDEX_SQL)
                target.commit()
                print('covering index ready')
                return
            target.executescript(SCHEMA)
            # Fresh projections get the covering index before any summaries.
            # Never perform an implicit large index build on a populated DB.
            if target.execute('SELECT 1 FROM head_summary LIMIT 1').fetchone() is None:
                target.execute(COVERING_INDEX_SQL)
                target.commit()
            while True:
                try:
                    count = advance(source, target, args.limit, models)
                    digest = contract(target, models)
                    ready = target.execute('SELECT 1 FROM evidence WHERE ready=1 LIMIT 1').fetchone() is not None
                    marker = Path(str(target_path) + '.ready')
                    temporary = Path(str(marker) + '.tmp')
                    temporary.write_text(json.dumps({'version': VERSION, 'models_sha256': digest,
                                                     'ready': ready, 'updated_ms': round(time.time()*1000)}))
                    os.replace(temporary, marker)
                    if not args.follow:
                        print('segments examined:', count)
                        break
                except sqlite3.OperationalError:
                    if not args.follow:
                        raise
                time.sleep(args.interval)
        finally:
            target.close()
            source.close()


if __name__ == '__main__':
    main()
