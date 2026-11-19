import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('essentia_index', Path(__file__).with_name('essentia-index.py'))
index = importlib.util.module_from_spec(spec)
spec.loader.exec_module(index)


class IncrementalIndexTest(unittest.TestCase):
    def test_incremental_read_only_and_freshness(self):
        with tempfile.TemporaryDirectory() as d:
            audio = Path(d) / 'fixture.audio'
            audio.write_bytes(b'audio')
            stat = audio.stat()
            source = sqlite3.connect(Path(d) / 'source.sqlite')
            source.executescript('''
              CREATE TABLE source_inventory(track_id TEXT PRIMARY KEY, source_path TEXT, nav_missing INTEGER, path_status TEXT);
              CREATE TABLE track_analysis(analysis_id INTEGER PRIMARY KEY, track_id TEXT, source_size INTEGER,
                source_mtime_ns INTEGER, status TEXT, summary_json TEXT,run_id TEXT);
              CREATE TABLE analysis_run(run_id TEXT PRIMARY KEY,code_version TEXT,provenance_json TEXT);
              CREATE TABLE track_segment(segment_id INTEGER PRIMARY KEY, analysis_id INTEGER);
              CREATE TABLE model_prediction(segment_id INTEGER, model_id TEXT, class_name TEXT, raw_score REAL,
                native_scale TEXT, missing_reason TEXT, PRIMARY KEY(segment_id,model_id,class_name));
            ''')
            source.execute('INSERT INTO source_inventory VALUES(?,?,0,?)', ('song', str(audio), 'mapped'))
            models = {'fixture': {'sha256': 'example'}}
            provenance = {'models': models, 'sample_rate': 16000,
                          'window_policy': 'up to five non-overlapping 10s windows: start, quartiles, end',
                          'inference_aggregation': 'mean over model patches per segment'}
            source.execute('INSERT INTO analysis_run VALUES(?,?,?)', ('run', 'essentia-window-v1', json.dumps(provenance)))
            source.execute('INSERT INTO track_analysis VALUES(1,?,?,?,?,?,?)',
                           ('song', stat.st_size, stat.st_mtime_ns, 'complete', '{"segments":2}', 'run'))
            source.executemany('INSERT INTO track_segment VALUES(?,1)', [(1,), (2,)])
            source.executemany('INSERT INTO model_prediction VALUES(?,?,?,?,?,NULL)', [
                (1, 'deam-msd-musicnn-2', 'arousal', 7, 'DEAM native [1,9], valence then arousal'),
                (2, 'deam-msd-musicnn-2', 'arousal', 5, 'DEAM native [1,9], valence then arousal'),
                (2, 'deam-msd-musicnn-2', 'valence', 8, 'wrong scale'),
            ])
            source.commit()
            source.execute('PRAGMA query_only=ON')
            target = sqlite3.connect(':memory:')
            target.executescript(index.SCHEMA)
            self.assertEqual(index.advance(source, target, 1, models), 1)
            self.assertEqual(target.execute('SELECT ready FROM evidence').fetchone()[0], 0)
            self.assertEqual(index.advance(source, target, 1, models), 1)
            ready, sums, counts = target.execute('SELECT ready,sums_json,counts_json FROM evidence').fetchone()
            self.assertEqual(ready, 1)
            self.assertEqual(json.loads(sums), {'deam:arousal': 12})
            self.assertEqual(json.loads(counts), {'deam:arousal': 2})
            self.assertEqual(index.advance(source, target, 1, models), 0)
            with self.assertRaises(ValueError):
                index.advance(source, target, 1, {'other': 'different model'})
            # A separate stale analysis is never published as ready.
            source.execute('PRAGMA query_only=OFF')
            source.execute('INSERT INTO track_analysis VALUES(2,?,?,?,?,?,?)',
                           ('song', stat.st_size + 1, stat.st_mtime_ns, 'complete', '{"segments":1}', 'run'))
            source.execute('INSERT INTO track_segment VALUES(3,2)')
            source.commit()
            source.execute('PRAGMA query_only=ON')
            self.assertEqual(index.advance(source, target, 1, models), 1)
            self.assertEqual(target.execute('SELECT count(*) FROM evidence').fetchone()[0], 1)
            source.close()
            target.close()


if __name__ == '__main__':
    unittest.main()
