// Host-only read model. Paths never leave this module. Source and projection are
// opened query-only; the caller supplies no paths over the socket.
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

/** Return only independently revalidated records; null means unavailable. */
export function readMusicEvidence(indexPath, sourcePath, expectedModelsHash, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 12 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !id || id.length > 256)) return null;
  let index;
  let source;
  try {
    index = new Database(indexPath, { readonly: true, fileMustExist: true, timeout: 50 });
    source = new Database(sourcePath, { readonly: true, fileMustExist: true, timeout: 50 });
    index.defaultSafeIntegers(true);
    source.defaultSafeIntegers(true);
    index.pragma('query_only = ON');
    source.pragma('query_only = ON');
    const contract = index.prepare('SELECT version,models_sha256 FROM contract WHERE id=1').get();
    if (!contract || contract.version !== 3n || !/^[a-f0-9]{64}$/.test(contract.models_sha256)
        || contract.models_sha256 !== expectedModelsHash) return null;
    const rows = index.prepare(`SELECT * FROM evidence WHERE ready=1 AND track_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const grouped = new Map();
    for (const row of rows) {
      const list = grouped.get(row.track_id) ?? [];
      list.push(row);
      grouped.set(row.track_id, list);
    }
    const readSource = source.prepare(`SELECT a.track_id,a.source_size,a.source_mtime_ns,i.source_path,
      r.run_id,r.code_version,r.provenance_json FROM track_analysis a
      JOIN source_inventory i ON i.track_id=a.track_id JOIN analysis_run r ON r.run_id=a.run_id
      WHERE a.analysis_id=? AND a.status='complete' AND i.nav_missing=0 AND i.path_status='mapped'`);
    const readWindows = index.prepare('SELECT * FROM windows WHERE analysis_id=? ORDER BY start_ms,segment_id');
    const readOutputs = index.prepare('SELECT model_id,class_name,raw_score,native_scale,missing_reason,validity FROM outputs WHERE segment_id=? ORDER BY model_id,class_name');
    const result = [];
    for (const id of ids) {
      const group = grouped.get(id);
      // Ambiguous analyses fail closed rather than guessing which identity wins.
      if (!group || group.length !== 1) continue;
      const row = group[0];
      const live = readSource.get(row.analysis_id);
      if (!live || live.track_id !== id || live.source_size !== row.source_size
          || live.source_mtime_ns !== row.source_mtime_ns || live.source_path !== row.source_path
          || live.run_id !== row.run_id || live.provenance_json !== row.provenance_json
          || live.code_version !== 'essentia-window-v1') continue;
      let provenance;
      try { provenance = JSON.parse(live.provenance_json); } catch { continue; }
      const hash = createHash('sha256').update(stableJson(provenance.models)).digest('hex');
      if (hash !== contract.models_sha256 || provenance.sample_rate !== 16000
          || provenance.window_policy !== 'up to five non-overlapping 10s windows: start, quartiles, end'
          || provenance.inference_aggregation !== 'mean over model patches per segment') continue;
      try {
        const stat = statSync(row.source_path, { bigint: true });
        if (!stat.isFile() || stat.size !== row.source_size || stat.mtimeNs !== row.source_mtime_ns) continue;
      } catch { continue; }
      const windows = readWindows.all(row.analysis_id);
      if (BigInt(windows.length) !== row.expected_windows || row.indexed_windows !== row.expected_windows) continue;
      result.push([id, {
        trackId: id, analysisId: String(row.analysis_id), runId: row.run_id, modelsHash: hash,
        sourceSize: String(row.source_size), sourceMtimeNs: String(row.source_mtime_ns),
        expectedWindows: Number(row.expected_windows),
        windows: windows.map(window => ({
          startMs: Number(window.start_ms), endMs: Number(window.end_ms), role: window.role,
          measurements: JSON.parse(window.measurements_json ?? 'null'),
          quality: JSON.parse(window.quality_json ?? 'null'),
          outputs: readOutputs.all(window.segment_id).map(output => ({
            modelId: output.model_id, label: output.class_name, value: output.raw_score,
            nativeScale: output.native_scale, missingReason: output.missing_reason,
            validity: output.validity,
          })),
        })),
      }]);
    }
    return result;
  } catch {
    return null;
  } finally {
    try { source?.close(); } catch {}
    try { index?.close(); } catch {}
  }
}
