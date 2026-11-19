// Isolated read-only helper: no stdout except a bounded JSON result.
import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function readIndex(path, req) {
 let db;
 let source;
 try {
  db = new Database(path, { readonly: true, fileMustExist: true, timeout: 50 });
  db.defaultSafeIntegers(true);
  db.pragma('query_only = ON');
  const contract = db.prepare('SELECT models_sha256,version FROM index_contract WHERE id=1').get();
  if (!contract || contract.version !== 2n || !/^[a-f0-9]{64}$/.test(contract.models_sha256)) throw Error('unverified index');
  if (req.expectedModelsHash && req.expectedModelsHash !== contract.models_sha256) throw Error('index contract changed');
  let rows = null;
  if (req.kind === 'lookup' && Array.isArray(req.ids) && req.ids.length > 0 && req.ids.length <= 12
      && req.ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)) {
    const placeholders = req.ids.map(() => '?').join(',');
    rows = db.prepare(`SELECT e.analysis_id,e.track_id,e.source_path,e.source_size,e.source_mtime_ns,t.trait,t.value FROM evidence e LEFT JOIN trait_value t ON t.analysis_id=e.analysis_id
      WHERE e.ready=1 AND e.track_id IN (${placeholders})`).all(...req.ids);
  } else if (req.kind === 'search' && typeof req.trait === 'string'
    && /^(deam:(arousal|valence)|binary:(danceable|voice|bright)|moods:[a-z]{1,64}|instruments:[a-z]{1,64})$/.test(req.trait)) {
    const direction = req.desc === false ? 'ASC' : 'DESC';
    rows = db.prepare(`WITH candidates AS (
      SELECT t.analysis_id FROM trait_value t WHERE t.trait=?
      ORDER BY t.value ${direction},t.analysis_id ${direction} LIMIT 256
    ), ids AS (
      SELECT DISTINCT e.track_id FROM evidence e JOIN candidates c ON c.analysis_id=e.analysis_id WHERE e.ready=1
    ) SELECT e.analysis_id,e.track_id,e.source_path,e.source_size,e.source_mtime_ns,t.trait,t.value FROM ids JOIN evidence e ON e.track_id=ids.track_id AND e.ready=1
      LEFT JOIN trait_value t ON t.analysis_id=e.analysis_id`).all(req.trait);
  }
  let result = null;
  if (rows) {
    const grouped = new Map();
    for (const row of rows) {
      let group = grouped.get(row.track_id);
      if (!group) { group = new Map(); grouped.set(row.track_id, group); }
      const key = String(row.analysis_id);
      if (!group.has(key)) group.set(key, { row, values: [] });
      group.get(key).values.push(row);
    }
    if (!req.sourcePath) throw Error('sidecar required');
    source = new Database(req.sourcePath, { readonly: true, fileMustExist: true, timeout: 50 });
    source.defaultSafeIntegers(true);
    source.pragma('query_only = ON');
    const analysisIds = [...grouped.values()].flatMap(group => [...group.values()].map(item => item.row.analysis_id));
    if (analysisIds.length > 512) throw Error('candidate ceiling');
    const live = analysisIds.length ? source.prepare(`SELECT a.analysis_id,a.track_id,a.source_size,a.source_mtime_ns,
      i.source_path,r.run_id,r.code_version,r.provenance_json FROM track_analysis a
      JOIN source_inventory i ON i.track_id=a.track_id JOIN analysis_run r ON r.run_id=a.run_id
      WHERE a.status='complete' AND i.nav_missing=0 AND i.path_status='mapped'
      AND a.analysis_id IN (${analysisIds.map(() => '?').join(',')})`).all(...analysisIds) : [];
    const liveById = new Map(live.map(row => [String(row.analysis_id), row]));
    const verifiedRuns = new Map();
    result = [];
    for (const [id, group] of grouped) {
      if (group.size !== 1 || typeof id !== 'string' || id.length > 256) continue;
      const { row, values } = group.values().next().value;
      const current = liveById.get(String(row.analysis_id));
      if (!current || current.track_id !== id || current.source_path !== row.source_path
          || current.source_size !== row.source_size || current.source_mtime_ns !== row.source_mtime_ns) continue;
      if (!verifiedRuns.has(current.run_id)) {
        try {
          const provenance = JSON.parse(current.provenance_json);
          const digest = createHash('sha256').update(stableJson(provenance.models)).digest('hex');
          verifiedRuns.set(current.run_id, digest === contract.models_sha256
            && current.code_version === 'essentia-window-v1' && provenance.sample_rate === 16000
            && provenance.window_policy === 'up to five non-overlapping 10s windows: start, quartiles, end'
            && provenance.inference_aggregation === 'mean over model patches per segment');
        } catch { verifiedRuns.set(current.run_id, false); }
      }
      if (!verifiedRuns.get(current.run_id)) continue;
      try {
        const stat = statSync(row.source_path, { bigint: true });
        if (!stat.isFile() || stat.size !== row.source_size || stat.mtimeNs !== row.source_mtime_ns) continue;
      } catch { continue; }
      const e = { moods: {}, instruments: {} };
      for (const { trait, value } of values) {
        if (typeof trait !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) continue;
        const [kind, label] = trait.split(':');
        if (kind === 'deam' && (label === 'arousal' || label === 'valence')) e[label] = value;
        if (kind === 'binary' && ['danceable', 'voice', 'bright'].includes(label)) e[label] = value;
        if ((kind === 'moods' || kind === 'instruments') && /^[a-z]{1,64}$/.test(label)) e[kind][label] = value;
      }
      result.push([id, e]);
    }
  }
  return result;
 } catch {
  return null;
 } finally {
  try { source?.close(); } catch {}
  try { db?.close(); } catch {}
 }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  try { process.stdout.write(JSON.stringify(readIndex(process.argv[2], JSON.parse(process.argv[3])))); }
  catch { process.stdout.write('null'); }
}
