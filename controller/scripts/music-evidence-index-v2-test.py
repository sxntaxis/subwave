import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('music_index_v2', Path(__file__).with_name('music-evidence-index-v2.py'))
index = importlib.util.module_from_spec(spec)
spec.loader.exec_module(index)


class ProjectionTest(unittest.TestCase):
    def test_incremental_provenance_raw_and_invalid_values(self):
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / 'fixture.audio'
            audio.write_bytes(b'fixture')
            stat = audio.stat()
            source_path = Path(directory) / 'source.sqlite'
            index_path = Path(directory) / 'index.sqlite'
            source = sqlite3.connect(source_path)
            source.executescript('''
              CREATE TABLE source_inventory(track_id TEXT PRIMARY KEY,source_path TEXT,nav_missing INTEGER,path_status TEXT);
              CREATE TABLE track_analysis(analysis_id INTEGER PRIMARY KEY,track_id TEXT,source_size INTEGER,
                source_mtime_ns INTEGER,status TEXT,summary_json TEXT,run_id TEXT);
              CREATE TABLE analysis_run(run_id TEXT PRIMARY KEY,code_version TEXT,provenance_json TEXT);
              CREATE TABLE track_segment(segment_id INTEGER PRIMARY KEY,analysis_id INTEGER,start_ms INTEGER,
                end_ms INTEGER,role TEXT,measurements_json TEXT,quality_json TEXT);
              CREATE TABLE model_prediction(segment_id INTEGER,model_id TEXT,class_name TEXT,raw_score REAL,
                native_scale TEXT,missing_reason TEXT,PRIMARY KEY(segment_id,model_id,class_name));
            ''')
            models = {'fixture': {'sha256': 'example'}}
            provenance = {'models': models, 'sample_rate': 16000,
                          'window_policy': 'up to five non-overlapping 10s windows: start, quartiles, end',
                          'inference_aggregation': 'mean over model patches per segment'}
            source.execute('INSERT INTO analysis_run VALUES(?,?,?)',
                           ('run', 'essentia-window-v1', json.dumps(provenance)))
            source.execute('INSERT INTO source_inventory VALUES(?,?,0,?)', ('song', str(audio), 'mapped'))
            source.execute('INSERT INTO track_analysis VALUES(1,?,?,?,?,?,?)',
                           ('song', stat.st_size, stat.st_mtime_ns, 'complete', '{"segments":2}', 'run'))
            source.executemany('INSERT INTO track_segment VALUES(?,?,?,?,?,?,?)', [
                (1, 1, 0, 10000, 'opening', '{"rms_linear":0.1}', '{}'),
                (2, 1, 20000, 30000, 'ending', '{"rms_linear":0.2}', '{}'),
            ])
            source.executemany('INSERT INTO model_prediction VALUES(?,?,?,?,?,?)', [
                (1, 'deam-msd-musicnn-2', 'arousal', 11.31, 'DEAM native [1,9], valence then arousal', None),
                (1, 'mtg_jamendo_instrument-discogs-effnet-1', 'piano', .7, 'model native; see metadata', None),
                (2, 'deam-msd-musicnn-2', 'arousal', 4.0, 'DEAM native [1,9], valence then arousal', None),
                (2, 'any-other-head', 'unknown', None, 'native', 'unavailable'),
            ])
            source.commit()
            source.execute('PRAGMA query_only=ON')
            target = sqlite3.connect(index_path)
            target.executescript(index.SCHEMA)
            self.assertEqual(index.advance(source, target, 1, models), 1)
            self.assertEqual(target.execute('SELECT ready FROM evidence').fetchone()[0], 0)
            self.assertEqual(index.advance(source, target, 1, models), 1)
            self.assertEqual(target.execute('SELECT ready FROM evidence').fetchone()[0], 1)
            self.assertEqual(target.execute('SELECT raw_score,validity FROM outputs WHERE segment_id=1 '
                                            'AND class_name="arousal"').fetchone(), (11.31, 'outside_declared_range'))
            self.assertEqual(target.execute('SELECT validity FROM outputs WHERE class_name="piano"').fetchone()[0], 'valid')
            self.assertEqual(target.execute('SELECT missing_reason,validity FROM outputs WHERE class_name="unknown"').fetchone(),
                             ('unavailable', 'source_missing'))
            self.assertEqual(target.execute('SELECT count(*) FROM windows').fetchone()[0], 2)
            self.assertEqual(index.advance(source, target, 1, models), 0)
            script = '''
import { readMusicEvidence } from './src/music/music-evidence-index-v2-reader.mjs';
const result = readMusicEvidence(process.argv[1], process.argv[2], process.argv[3], ['song']);
console.log(JSON.stringify(result));
'''
            def read():
                out = subprocess.check_output(['node', '--input-type=module', '-e', script,
                                               str(index_path), str(source_path), index._v1.models_hash(models)],
                                              cwd=Path(__file__).resolve().parent.parent, text=True)
                return json.loads(out)
            result = read()
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0][0], 'song')
            self.assertEqual(result[0][1]['windows'][0]['outputs'][0]['validity'], 'outside_declared_range')
            self.assertNotIn(str(audio), json.dumps(result))
            audio.write_bytes(b'changed-size')
            self.assertEqual(read(), [])
            with self.assertRaises(ValueError):
                index.advance(source, target, 1, {'other': {}})


if __name__ == '__main__':
    unittest.main()
