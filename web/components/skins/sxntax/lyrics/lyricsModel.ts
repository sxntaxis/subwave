/**
 * Presentation-only lyrics vocabulary. No provider, persistence or public API
 * contract is implied by these types. In particular, a line timestamp is not
 * a timestamp for an individual listener's audible audio output.
 */
export type LyricsTiming = 'plain' | 'line' | 'word';

export interface LyricSegment {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface LyricLine {
  readonly id: string;
  readonly text: string;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly segments?: readonly LyricSegment[];
  readonly vocalLayers?: readonly {
    readonly agentId: string;
    readonly role: 'bg' | 'voice' | 'group';
    readonly name?: string;
    readonly segments: readonly LyricSegment[];
  }[];
}

export interface LyricDocument {
  readonly id: string;
  readonly timing: LyricsTiming;
  readonly language?: string;
  readonly lines: readonly LyricLine[];
  readonly attribution?: string;
  readonly agents?: readonly { readonly id: string; readonly role: 'main' | 'bg' | 'voice' | 'group'; readonly name?: string }[];
  readonly alternates?: readonly { readonly kind: 'translation' | 'pronunciation'; readonly language?: string; readonly lines: readonly {readonly text:string; readonly startMs?:number}[] }[];
}

export interface LyricsCursor {
  readonly line: number;
  readonly segment: number;
}

export const NO_LYRICS_CURSOR: LyricsCursor = Object.freeze({ line: -1, segment: -1 });

/**
 * Find the last started lyric line, not the nearest lyric. An explicit endMs
 * can close the active interval; missing ends remain unknown, not invented.
 * Word-level progress is reported only for real segment timestamps.
 */
export function lyricsCursorAt(document: LyricDocument | null, positionMs: number | null): LyricsCursor {
  if (!document || document.timing === 'plain' || positionMs === null ||
      !Number.isFinite(positionMs) || positionMs < 0) return NO_LYRICS_CURSOR;

  let active = -1;
  for (let index = 0; index < document.lines.length; index += 1) {
    const line = document.lines[index];
    if (!line || typeof line.startMs !== 'number' || !Number.isFinite(line.startMs)) continue;
    if (line.startMs > positionMs) break;
    active = index;
  }
  if (active < 0) return NO_LYRICS_CURSOR;

  const line = document.lines[active];
  if (!line || (line.endMs !== undefined && positionMs >= line.endMs)) return NO_LYRICS_CURSOR;
  if (document.timing !== 'word' || !line.segments?.length) return { line: active, segment: -1 };

  let segment = -1;
  for (let index = 0; index < line.segments.length; index += 1) {
    const item = line.segments[index];
    if (!item || !Number.isFinite(item.startMs) || item.startMs > positionMs) break;
    if (Number.isFinite(item.endMs) && positionMs < item.endMs) segment = index;
  }
  return { line: active, segment };
}

/** Renderer safety for eventual untrusted-source integration. */
export function validLyricDocument(document: LyricDocument): boolean {
  if (!document.id || !['plain', 'line', 'word'].includes(document.timing) ||
      document.lines.length === 0 || document.lines.length > 2500) return false;
  let previous = -1;
  const ids = new Set<string>();
  for (const line of document.lines) {
    if (!line.id || ids.has(line.id) || typeof line.text !== 'string' || line.text.length > 2000) return false;
    ids.add(line.id);
    if (document.timing === 'plain') {
      if (line.startMs !== undefined || line.segments !== undefined) return false;
      continue;
    }
    if (line.startMs === undefined || !Number.isFinite(line.startMs) || line.startMs < previous) return false;
    if (line.endMs !== undefined && (!Number.isFinite(line.endMs) || line.endMs <= line.startMs)) return false;
    previous = line.startMs;
    if (document.timing === 'line' && line.segments !== undefined) return false;
    if (line.vocalLayers) {
      if (line.vocalLayers.length > 12) return false;
      for (const layer of line.vocalLayers) {
        if (!layer.agentId || !['bg', 'group', 'voice'].includes(layer.role) ||
            layer.segments.length === 0 || layer.segments.length > 1000) return false;
        for (const part of layer.segments) {
          if (!part.text || !Number.isFinite(part.startMs) || !Number.isFinite(part.endMs) ||
              part.endMs <= part.startMs) return false;
        }
      }
    }
    if (!line.segments) continue;
    if (document.timing !== 'word' || line.segments.length > 1000 || line.segments.length === 0) return false;
    let end = line.startMs;
    for (const segment of line.segments) {
      if (!segment.text || !Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs) ||
          segment.startMs < end || segment.endMs <= segment.startMs ||
          (line.endMs !== undefined && segment.endMs > line.endMs)) return false;
      end = segment.endMs;
    }
    // Never allow word segments to silently disagree with the displayed line.
    if (line.segments.map(item => item.text).join('') !== line.text) return false;
  }
  if (document.agents && (document.agents.length > 32 || document.agents.some(
    a => !a.id || !['main', 'bg', 'voice', 'group'].includes(a.role)))) return false;
  if (document.alternates && (document.alternates.length > 8 || document.alternates.some(
    a => !['translation', 'pronunciation'].includes(a.kind) || a.lines.length > 2500 ||
      a.lines.some(l => !l.text || l.text.length > 2000 ||
        (l.startMs !== undefined && (!Number.isFinite(l.startMs) || l.startMs < 0)))))) return false;
  return true;
}
