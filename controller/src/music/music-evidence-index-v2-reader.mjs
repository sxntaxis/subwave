// Host-only read model. Paths never leave this module. Source and projection are
// opened query-only; the caller supplies no paths over the socket.
import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { rankMusicCandidates } from './music-joint-ranking.mjs';

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

const HEADS = {
  arousal: ['deam-msd-musicnn-2', 'arousal', 1, 9],
  valence: ['deam-msd-musicnn-2', 'valence', 1, 9],
  danceability: ['danceability-discogs-effnet-1', 'danceable', 0, 1],
  voice: ['voice_instrumental-discogs-effnet-1', 'voice', 0, 1],
  timbre: ['timbre-discogs-effnet-1', 'bright', 0, 1],
};
const LABEL_HEADS = {
  mood: 'mtg_jamendo_moodtheme-discogs-effnet-1',
  instrument: 'mtg_jamendo_instrument-discogs-effnet-1',
};

/** Jointly rank indexed summaries before any shortlist cap. */
export function searchMusicEvidence(indexPath, sourcePath, expectedModelsHash, request) {
  const benchmark = process.env.MUSIC_V2_BENCH_TIMINGS === '1';
  const started = benchmark ? performance.now() : 0;
  const { preferences, requiredFamilies = [], eligibleIds = null, limit = 8 } = request ?? {};
  if (!Array.isArray(preferences) || !preferences.length || preferences.length > 16
      || !Array.isArray(requiredFamilies) || requiredFamilies.length > 7
      || !Number.isInteger(limit) || limit < 1 || limit > 12
      || (eligibleIds !== null && (!Array.isArray(eligibleIds) || eligibleIds.length > 128
          || new Set(eligibleIds).size !== eligibleIds.length
          || eligibleIds.some(id => typeof id !== 'string' || !id || id.length > 256)))) return null;
  if (eligibleIds?.length === 0) return { results: [], rankedCount: 0, rejectedFreshness: 0 };
  const specs = [];
  for (const p of preferences) {
    if (!p || Object.keys(p).some(k => !['family', 'key', 'direction', 'weight'].includes(k))
        || !['high', 'low'].includes(p.direction)
        || (p.weight !== undefined && (!Number.isFinite(p.weight) || p.weight <= 0 || p.weight > 10))) return null;
    let spec;
    if (Object.hasOwn(HEADS, p.family) && p.key === 'value') spec = HEADS[p.family];
    else if (Object.hasOwn(LABEL_HEADS, p.family) && typeof p.key === 'string'
        && /^[a-z]{1,32}$/.test(p.key)) spec = [LABEL_HEADS[p.family], p.key, 0, 1];
    else return null;
    specs.push({ p, model: spec[0], label: spec[1], min: spec[2], max: spec[3] });
  }
  if (requiredFamilies.some(f => typeof f !== 'string' || !specs.some(s => s.p.family === f))) return null;
  let db;
  try {
    db = new Database(indexPath, { readonly: true, fileMustExist: true, timeout: 50 });
    db.pragma('query_only = ON');
    const contract = db.prepare('SELECT version,models_sha256 FROM contract WHERE id=1').get();
    if (!contract || contract.version !== 3 || contract.models_sha256 !== expectedModelsHash) return null;
    const predicates = specs.map(() => '(h.model_id=? AND h.class_name=?)').join(' OR ');
    const pivot = specs.map((_, i) =>
      `MAX(CASE WHEN h.model_id=? AND h.class_name=? THEN h.mean END) AS v${i}`).join(',');
    const headParameters = specs.flatMap(s => [s.model, s.label]);
    const parameters = [...headParameters, ...headParameters];
    let scope = '';
    if (eligibleIds) {
      scope = ` AND e.track_id IN (${eligibleIds.map(() => '?').join(',')})`;
      parameters.push(...eligibleIds);
    }
    // For a bounded eligible cohort, drive the indexed track identities first.
    // SQLite otherwise may drive the global head_summary index and then discard
    // almost every row by track ID. CROSS JOIN preserves the inner-join result
    // while preventing that reordering; unscoped discovery keeps its old plan.
    const join = eligibleIds === null ? 'JOIN' : 'CROSS JOIN';
    // Explicit ceilings fail open; never silently truncate before joint ranking.
    const rows = db.prepare(`SELECT e.track_id,e.analysis_id,COUNT(*) AS matched_rows,${pivot}
      FROM evidence e ${join} head_summary h ON h.analysis_id=e.analysis_id
      WHERE e.ready=1 AND (${predicates})${scope} GROUP BY e.analysis_id`).all(...parameters);
    const queried = benchmark ? performance.now() : 0;
    if (rows.reduce((sum, row) => sum + row.matched_rows, 0) > 800000) return null;
    const candidates = new Map();
    for (const row of rows) {
      const entry = candidates.get(row.track_id) ?? { id: row.track_id, values: {}, analyses: new Set() };
      entry.analyses.add(row.analysis_id);
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        const mean = row[`v${i}`];
        if (typeof mean !== 'number' || !Number.isFinite(mean) || mean < spec.min || mean > spec.max) continue;
        entry.values[spec.p.family] ??= {};
        entry.values[spec.p.family][spec.p.key] = (mean - spec.min) / (spec.max - spec.min);
      }
      candidates.set(row.track_id, entry);
    }
    const ranked = rankMusicCandidates([...candidates.values()].filter(c => c.analyses.size === 1), preferences, requiredFamilies);
    const rankedAt = benchmark ? performance.now() : 0;
    if (!ranked) return null;
    const results = [];
    let rejectedFreshness = 0;
    let checkedCount = 0;
    // Filesystem probes can block on the music disk: never stat an unbounded
    // library while handling a single socket request.
    const freshnessCeiling = 128;
    for (let offset = 0; offset < Math.min(ranked.length, freshnessCeiling) && results.length < limit; offset += 12) {
      const batch = ranked.slice(offset, Math.min(offset + 12, freshnessCeiling));
      const checked = readMusicEvidence(indexPath, sourcePath, expectedModelsHash, batch.map(x => x.id));
      if (!checked) return null;
      const valid = new Set(checked.map(([id]) => id));
      for (const item of batch) {
        checkedCount++;
        if (!valid.has(item.id)) rejectedFreshness++;
        else if (results.length < limit) results.push(item);
      }
    }
    if (benchmark) process.stderr.write(JSON.stringify({
      benchmark: 'music-v2',
      queryMs: +(queried - started).toFixed(2),
      rankingMs: +(rankedAt - queried).toFixed(2),
      freshnessMs: +(performance.now() - rankedAt).toFixed(2),
      checkedCount,
    }) + '\n');
    return { results, rankedCount: ranked.length, rejectedFreshness, checkedCount,
      verificationLimited: results.length < limit && ranked.length > checkedCount && checkedCount >= freshnessCeiling };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
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

/** Classify evidence state without exposing host paths or source-side values.
 *
 * A completed analysis whose projection has not arrived is unindexed, not
 * unanalyzed. Ambiguous identities are never resolved by choosing a row.
 */
export function inspectMusicEvidenceStatus(indexPath, sourcePath, expectedModelsHash, ids) {
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
    if (!contract || contract.version !== 3n || contract.models_sha256 !== expectedModelsHash) return null;
    const sourceRows = source.prepare(`SELECT a.analysis_id,a.track_id,a.source_size,a.source_mtime_ns,
      i.source_path,r.run_id,r.code_version,r.provenance_json FROM track_analysis a
      JOIN source_inventory i ON i.track_id=a.track_id JOIN analysis_run r ON r.run_id=a.run_id
      WHERE a.track_id=? AND a.status='complete' AND i.nav_missing=0 AND i.path_status='mapped'`);
    const indexed = index.prepare('SELECT ready FROM evidence WHERE analysis_id=? AND track_id=?');
    const valid = readMusicEvidence(indexPath, sourcePath, expectedModelsHash, ids);
    if (!valid) return null;
    const evidenceById = new Map(valid);
    return ids.map(id => {
      const rows = sourceRows.all(id);
      if (!rows.length) return { id, status: 'unanalyzed' };
      if (rows.length !== 1) return { id, status: 'ambiguous_identity' };
      const row = rows[0];
      let provenance;
      try { provenance = JSON.parse(row.provenance_json); } catch { return { id, status: 'provenance_mismatch' }; }
      if (row.code_version !== 'essentia-window-v1'
          || createHash('sha256').update(stableJson(provenance.models)).digest('hex') !== expectedModelsHash
          || provenance.sample_rate !== 16000
          || provenance.window_policy !== 'up to five non-overlapping 10s windows: start, quartiles, end'
          || provenance.inference_aggregation !== 'mean over model patches per segment') {
        return { id, status: 'provenance_mismatch' };
      }
      try {
        const stat = statSync(row.source_path, { bigint: true });
        if (!stat.isFile() || stat.size !== row.source_size || stat.mtimeNs !== row.source_mtime_ns) {
          return { id, status: 'stale_source' };
        }
      } catch { return { id, status: 'stale_source' }; }
      const projection = indexed.get(row.analysis_id, id);
      if (!projection || projection.ready !== 1n) return { id, status: 'unindexed' };
      const evidence = evidenceById.get(id);
      if (!evidence) return { id, status: 'integrity_mismatch' };
      const coverage = {};
      for (const window of evidence.windows) {
        for (const output of window.outputs) {
          const head = coverage[output.modelId] ?? { valid: 0, invalid: 0, missing: 0, total: 0 };
          head.total++;
          if (output.validity === 'valid') head.valid++;
          else if (output.validity === 'source_missing') head.missing++;
          else head.invalid++;
          coverage[output.modelId] = head;
        }
      }
      return { id, status: 'indexed', expectedWindows: evidence.expectedWindows, coverage };
    });
  } catch {
    return null;
  } finally {
    try { source?.close(); } catch {}
    try { index?.close(); } catch {}
  }
}
