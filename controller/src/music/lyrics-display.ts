/**
 * Normalize Navidrome / OpenSubsonic songLyrics v1 and v2 for radio listeners.
 * Preserve source text and source timing; never synthesize missing word ends.
 * This module never acquires or redistributes lyrics independently of Navidrome.
 */
export interface DisplayLyricSegment {
  text: string;
  startMs: number;
  endMs: number;
}
export interface DisplayLyricLine {
  id: string;
  text: string;
  startMs?: number;
  endMs?: number;
  segments?: DisplayLyricSegment[];
  /** Individually attributed cue layers, separate from primary lyric text. */
  vocalLayers?: DisplayVocalLayer[];
}
export interface DisplayVocalLayer {
  agentId: string;
  role: 'bg' | 'voice' | 'group';
  name?: string;
  segments: DisplayLyricSegment[];
}
export interface DisplayLyricAlternate {
  kind: 'translation' | 'pronunciation';
  language?: string;
  lines: Array<{ text: string; startMs?: number }>;
}
export interface DisplayLyricAgent {
  id: string;
  role: 'main' | 'bg' | 'voice' | 'group';
  name?: string;
}
export interface DisplayLyrics {
  id: string;
  timing: 'plain' | 'line' | 'word';
  language?: string;
  lines: DisplayLyricLine[];
  attribution?: string;
  agents?: DisplayLyricAgent[];
  alternates?: DisplayLyricAlternate[];
}

const MAX_LINES = 2500;
const MAX_LINE_LENGTH = 2000;
const MAX_SEGMENTS = 1000;

function textLines(value: string): string[] {
  return value.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim())
    .filter(Boolean).slice(0, MAX_LINES);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteMilliseconds(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * v2 cue offsets are inclusive *UTF-8 byte* positions, not JS string indexes.
 * Only use a main/default agent whose cueLine text exactly matches the displayed
 * combined line. Other voices, translations and pronunciations are independent
 * layers and must never be silently merged into the primary transcript.
 */
function timedSegments(rawLine: unknown, cueLines: unknown, agents: unknown, index: number,
  offset: number, lineStart: number): { segments: DisplayLyricSegment[]; endMs?: number } | null {
  if (!rawLine || typeof rawLine !== 'object' || !Array.isArray(cueLines)) return null;
  const text = (rawLine as { value?: unknown }).value;
  if (!validText(text) || text !== text.trim() || text.includes('\n') || text.includes('\r')) return null;

  const mainId = Array.isArray(agents) ? agents.find(
    (agent: unknown) => agent && typeof agent === 'object' && (agent as { role?: unknown }).role === 'main',
  )?.id : undefined;
  const matches = cueLines.filter((value: unknown) => value && typeof value === 'object' &&
    (value as { index?: unknown }).index === index && (value as { value?: unknown }).value === text &&
    (!Array.isArray(agents) || (mainId !== undefined && (value as { agentId?: unknown }).agentId === mainId)));
  if (matches.length === 0) return null;
  const cueLine = matches[0] as { cue?: unknown; end?: unknown };
  if (!Array.isArray(cueLine.cue) || cueLine.cue.length < 1 || cueLine.cue.length > MAX_SEGMENTS) return null;
  const bytes = Buffer.from(text, 'utf8');
  let previousByte = -1;
  let previousEnd = lineStart;
  const segments: DisplayLyricSegment[] = [];
  for (const item of cueLine.cue) {
    if (!item || typeof item !== 'object') return null;
    const cue = item as { value?: unknown; byteStart?: unknown; byteEnd?: unknown; start?: unknown; end?: unknown };
    const first = cue.byteStart;
    const last = cue.byteEnd;
    const rawStart = finiteMilliseconds(cue.start);
    const rawEnd = finiteMilliseconds(cue.end);
    // Start-only cues remain line-timed: fabricating an end time would imply
    // a level of karaoke precision the source does not provide.
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) ||
        (first as number) <= previousByte || (last as number) < (first as number) ||
        (last as number) >= bytes.length || rawStart === null || rawEnd === null) return null;
    const startMs = Math.max(0, rawStart - offset);
    const endMs = Math.max(0, rawEnd - offset);
    if (startMs < lineStart || startMs < previousEnd || endMs <= startMs) return null;
    const fragment = bytes.subarray(first as number, (last as number) + 1);
    const decoded = fragment.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(fragment) || decoded !== cue.value) return null;
    const gap = bytes.subarray(previousByte + 1, first as number);
    const gapText = gap.toString('utf8');
    if (!Buffer.from(gapText).equals(gap)) return null;
    if (segments.length) segments[segments.length - 1]!.text += gapText;
    else if (gap.length) return null;
    segments.push({ text: decoded, startMs, endMs });
    previousByte = last as number;
    previousEnd = endMs;
  }
  const trailingBytes = bytes.subarray(previousByte + 1);
  const trailing = trailingBytes.toString('utf8');
  if (!Buffer.from(trailing).equals(trailingBytes)) return null;
  segments[segments.length - 1]!.text += trailing;
  if (segments.map(segment => segment.text).join('') !== text) return null;
  const rawLineEnd = finiteMilliseconds(cueLine.end);
  const lineEnd = rawLineEnd === null ? undefined : Math.max(0, rawLineEnd - offset);
  if (lineEnd !== undefined && (lineEnd <= lineStart || lineEnd < previousEnd)) return null;
  return { segments, ...(lineEnd !== undefined ? { endMs: lineEnd } : {}) };
}

/** A non-main cue layer may only cover part of a combined display line. The
 * byte offsets remain authoritative; never treat its text as the main line. */
function attributedCueSegments(raw: unknown, offset: number): DisplayLyricSegment[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { value?: unknown; cue?: unknown };
  if (!validText(record.value) || !Array.isArray(record.cue) ||
      record.cue.length === 0 || record.cue.length > MAX_SEGMENTS) return null;
  const bytes = Buffer.from(record.value, 'utf8');
  const out: DisplayLyricSegment[] = [];
  let previousByte = -1;
  let previousEnd = -1;
  for (const item of record.cue) {
    if (!item || typeof item !== 'object') return null;
    const cue = item as { value?: unknown; byteStart?: unknown; byteEnd?: unknown; start?: unknown; end?: unknown };
    const a = cue.byteStart;
    const b = cue.byteEnd;
    const start = finiteMilliseconds(cue.start);
    const end = finiteMilliseconds(cue.end);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || (a as number) <= previousByte ||
        (b as number) < (a as number) || (b as number) >= bytes.length ||
        start === null || end === null || end <= start) return null;
    const slice = bytes.subarray(a as number, (b as number) + 1);
    const decoded = slice.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(slice) || decoded !== cue.value ||
        start - offset < previousEnd || start - offset < 0) return null;
    out.push({ text: decoded, startMs: start - offset, endMs: end - offset });
    previousByte = b as number;
    previousEnd = end - offset;
  }
  return out;
}

function structuredAgents(source: any): DisplayLyricAgent[] {
  if (!Array.isArray(source?.agents) || !Array.isArray(source?.cueLine)) return [];
  const agents: DisplayLyricAgent[] = [];
  const known = new Set<string>();
  for (const candidate of source.agents) {
    const role = candidate?.role;
    if (!validText(candidate?.id) || known.has(candidate.id) ||
        !['main', 'bg', 'voice', 'group'].includes(role)) return [];
    known.add(candidate.id);
    agents.push({ id: candidate.id, role,
      ...(validText(candidate?.name) ? { name: candidate.name.slice(0, 100) } : {}) });
  }
  return agents.filter(a => a.role === 'main').length === 1 ? agents : [];
}

/** Preserve other vocals only when Navidrome explicitly attributes their cueLine
 * to a known non-main agent. No speech text is manufactured. */
function vocalLayers(source: any, sourceIndex: number, offset: number,
  agents: DisplayLyricAgent[]): DisplayVocalLayer[] {
  if (!agents.length || !Array.isArray(source?.cueLine)) return [];
  const result: DisplayVocalLayer[] = [];
  for (const cueLine of source.cueLine) {
    if (cueLine?.index !== sourceIndex) continue;
    const agent = agents.find(a => a.id === cueLine?.agentId);
    if (!agent || agent.role === 'main') continue;
    const segments = attributedCueSegments(cueLine, offset);
    if (segments?.length) result.push({agentId: agent.id, role: agent.role,
      ...(agent.name ? { name: agent.name } : {}), segments});
    if (result.length >= 12) break;
  }
  return result;
}

/** Translation and pronunciation are independent tracks in songLyrics v2.
 * Keep their own timing rather than assuming line indexes match the main text. */
function alternateLyrics(variants: any[]): DisplayLyricAlternate[] {
  const out: DisplayLyricAlternate[] = [];
  for (const v of variants) {
    if (v?.kind !== 'translation' && v?.kind !== 'pronunciation') continue;
    if (!Array.isArray(v?.line)) continue;
    const safeOffset = Number.isFinite(Number(v.offset)) ? Number(v.offset) : 0;
    const lines: DisplayLyricAlternate['lines'] = [];
    for (const line of v.line) {
      if (!validText(line?.value) || line.value.length > MAX_LINE_LENGTH) continue;
      const start = finiteMilliseconds(line.start);
      lines.push({ text: line.value,
        ...(v.synced === true && start !== null ? { startMs: Math.max(0, start - safeOffset) } : {}) });
      if (lines.length >= MAX_LINES) break;
    }
    if (lines.length) out.push({ kind: v.kind,
      ...(validText(v.lang) ? { language: v.lang.slice(0, 30) } : {}), lines });
    if (out.length >= 8) break;
  }
  return out;
}

export function normalizeNavidromeLyrics(songId: string, response: any): DisplayLyrics | null {
  const candidates = response?.lyricsList?.structuredLyrics;
  const variants: Array<{ timing: DisplayLyrics['timing']; lines: DisplayLyricLine[]; language?: string; source: any }> = [];

  if (Array.isArray(candidates)) for (const candidate of candidates) {
    // Enhanced response layers are not interchangeable. The primary listener
    // transcript is always main vocals; a translation alone is not a master.
    if (candidate?.kind !== undefined && candidate.kind !== 'main') continue;
    const sourceLines = Array.isArray(candidate?.line) ? candidate.line : [];
    const offset = Number(candidate?.offset ?? 0);
    const safeOffset = Number.isFinite(offset) ? offset : 0;
    const language = validText(candidate?.lang) ? candidate.lang : undefined;
    const synced = candidate?.synced === true;
    const lines: DisplayLyricLine[] = [];
    let isTimed = synced;
    let hasSegments = false;
    let previous = -1;
    const agents = structuredAgents(candidate);
    for (const [sourceIndex, source] of sourceLines.entries()) {
      const raw = source?.value;
      if (!validText(raw)) continue;
      const parts = textLines(raw);
      for (const text of parts) {
        if (lines.length >= MAX_LINES) break;
        if (text.length > MAX_LINE_LENGTH) continue;
        const line: DisplayLyricLine = { id: String(lines.length), text };
        if (synced) {
          const start = finiteMilliseconds(source?.start);
          const adjusted = start === null ? null : Math.max(0, start - safeOffset);
          if (adjusted === null || adjusted < previous) isTimed = false;
          else {
            line.startMs = adjusted;
            previous = adjusted;
            // cueLine indexes refer to original line entries, not split text.
            if (parts.length === 1) {
              const cues = timedSegments(source, candidate?.cueLine, candidate?.agents,
                sourceIndex, safeOffset, adjusted);
              if (cues) {
                line.segments = cues.segments;
                if (cues.endMs !== undefined) line.endMs = cues.endMs;
                hasSegments = true;
              }
              const layers = vocalLayers(candidate, sourceIndex, safeOffset, agents);
              if (layers.length) line.vocalLayers = layers;
            }
          }
        }
        lines.push(line);
      }
    }
    if (lines.length) variants.push({
      timing: isTimed ? hasSegments ? 'word' : 'line' : 'plain', lines, language,
      source: candidate,
    });
  }
  const selected = variants.find(v => v.timing === 'word') ??
    variants.find(v => v.timing === 'line') ?? variants[0];
  if (selected) return {
    id: `navidrome:${songId}`,
    timing: selected.timing,
    ...(selected.language ? { language: selected.language } : {}),
    lines: selected.lines.map(line => selected.timing === 'plain' ? { id: line.id, text: line.text } : line),
    ...(structuredAgents(selected.source).length ? { agents: structuredAgents(selected.source) } : {}),
    ...(alternateLyrics(candidates).length ? { alternates: alternateLyrics(candidates) } : {}),
  };

  const legacy = response?.lyrics?.value;
  if (!validText(legacy)) return null;
  const lines = textLines(legacy).filter(line => line.length <= MAX_LINE_LENGTH)
    .map((text, i) => ({ id: String(i), text }));
  return lines.length ? { id: `navidrome:${songId}`, timing: 'plain', lines } : null;
}
