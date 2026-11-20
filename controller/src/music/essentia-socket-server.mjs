// Host-only, local socket facade over the independently maintained index.
// Never accepts filesystem paths from the client or logs track data.
import { createConnection, createServer } from 'node:net';
import { accessSync, chmodSync, constants, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readIndex } from './essentia-index-reader.mjs';
import { searchMusicEvidence } from './music-evidence-index-v2-reader.mjs';

const [directory, indexPath, sourcePath, indexV2Path] = process.argv.slice(2);
if (!directory || !indexPath || !sourcePath) process.exit(2);
const socketPath = join(directory, 'evidence.sock');
const readyPath = join(directory, 'ready.json');
process.umask(0o077);
try {
  const old = lstatSync(socketPath);
  if (!old.isSocket() || old.uid !== process.getuid()) process.exit(2);
  const active = await new Promise(resolve => {
    const probe = createConnection(socketPath);
    probe.setTimeout(500, () => { probe.destroy(); resolve(true); });
    probe.on('connect', () => { probe.destroy(); resolve(true); });
    probe.on('error', err => resolve(err.code !== 'ECONNREFUSED'));
  });
  if (active) process.exit(2);
  unlinkSync(socketPath);
} catch (err) {
  if (err.code !== 'ENOENT') process.exit(2);
}
function readiness() {
  try {
    accessSync(sourcePath, constants.R_OK);
    accessSync(indexPath, constants.R_OK);
    const marker = JSON.parse(readFileSync(`${indexPath}.ready`, 'utf8'));
    const age = Date.now() - marker.updated_ms;
    if (marker.version !== 2 || marker.ready !== true || !Number.isFinite(age) || age < 0 || age > 90_000
        || typeof marker.models_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(marker.models_sha256)) return null;
    return marker;
  } catch { return null; }
}
function v2Readiness() {
  if (!indexV2Path) return null;
  try {
    accessSync(sourcePath, constants.R_OK);
    accessSync(indexV2Path, constants.R_OK);
    const marker = JSON.parse(readFileSync(`${indexV2Path}.ready`, 'utf8'));
    const age = Date.now() - marker.updated_ms;
    if (marker.version !== 3 || marker.ready !== true || !Number.isFinite(age) || age < 0 || age > 90_000
        || typeof marker.models_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(marker.models_sha256)) return null;
    return marker;
  } catch { return null; }
}
function publishReadiness() {
  const marker = readiness();
  const path = readyPath + '.tmp';
  try {
    writeFileSync(path, JSON.stringify({ ready: !!marker, updated_ms: Date.now() }), { mode: 0o600 });
    renameSync(path, readyPath);
  } catch {}
}
const server = createServer(socket => {
  socket.setTimeout(2000, () => socket.destroy());
  let input = '';
  socket.on('error', () => {});
  socket.on('data', chunk => {
    input += chunk.toString('utf8');
    if (Buffer.byteLength(input) > 32768) return socket.destroy();
    if (!input.includes('\n')) return;
    socket.pause();
    let result = null;
    try {
      const request = JSON.parse(input.slice(0, input.indexOf('\n')));
      const marker = readiness();
      const v2marker = request?.version === 2 && request.op === 'searchJoint' ? v2Readiness() : null;
      if (v2marker && Object.keys(request).every(key =>
        ['version', 'op', 'preferences', 'requiredFamilies', 'eligibleIds', 'limit'].includes(key))) {
        result = searchMusicEvidence(indexV2Path, sourcePath, v2marker.models_sha256, request);
      }
      const lookup = request?.version === 1 && request.op === 'profiles'
        && Array.isArray(request.ids) && request.ids.length > 0 && request.ids.length <= 12
        && new Set(request.ids).size === request.ids.length
        && request.ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256);
      const search = request?.version === 1 && request.op === 'searchTraits'
        && typeof request.trait === 'string'
        && /^(deam:(arousal|valence)|binary:(danceable|voice|bright)|moods:(calm|dark|energetic|happy|melancholic|relaxing|sad|upbeat)|instruments:(acousticguitar|drums|electricguitar|piano|saxophone|strings|synthesizer))$/.test(request.trait)
        && typeof request.desc === 'boolean';
      const keys = Object.keys(request ?? {});
      const allowed = lookup ? ['version', 'op', 'ids'] : ['version', 'op', 'trait', 'desc'];
      if (marker && (lookup || search) && keys.every(key => allowed.includes(key))) {
        result = readIndex(indexPath, {
          kind: lookup ? 'lookup' : 'search', ids: request.ids, trait: request.trait, desc: request.desc,
          sourcePath, expectedModelsHash: marker.models_sha256,
        });
      }
    } catch {}
    const encoded = JSON.stringify(result);
    socket.end((Buffer.byteLength(encoded) <= 2 * 1024 * 1024 ? encoded : 'null') + '\n');
  });
});
server.maxConnections = 8;
server.listen(socketPath, () => { chmodSync(socketPath, 0o600); publishReadiness(); });
const timer = setInterval(publishReadiness, 10_000);
timer.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => process.exit(0));
  try { unlinkSync(socketPath); } catch {}
  try { unlinkSync(readyPath); } catch {}
});
