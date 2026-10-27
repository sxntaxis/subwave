import { validLyricDocument, type LyricDocument, type LyricSegment } from './lyricsModel';

/** Native YouLyPlus v5 data format; milliseconds for syllables, seconds for lines. */
export interface YoulyVocalSyllable {
  text: string;
  time: number;
  duration: number;
  isBackground?: boolean;
}
export interface YoulyVocalLine {
  text: string;
  startTime?: number;
  endTime?: number;
  element: { songPartIndex: number; singer?: string };
  syllabus?: YoulyVocalSyllable[];
  translatedText?: string;
  romanizedText?: string;
}
export interface YoulyLyrics {
  type: 'None' | 'Line' | 'Word';
  data: YoulyVocalLine[];
  metadata: { source?: string; agents?: Record<string, { type: string }> };
}

const withoutWhitespace = (text: string) => text.replace(/\s/gu, '');

/** Non-main OpenSubsonic cues can omit the gaps between their byte ranges.
 * Only restore whitespace when the attributed text already covers the exact
 * displayed line. Keep every actual cue timestamp and never add a word. */
function withLineWhitespace(text: string, segments: readonly LyricSegment[]): LyricSegment[] {
  let cursor = 0;
  const result: LyricSegment[] = [];
  for (const segment of segments) {
    const from = cursor;
    let remaining = withoutWhitespace(segment.text).length;
    if (!remaining) while (cursor < text.length && /\s/u.test(text[cursor]!)) cursor++;
    while (cursor < text.length && remaining > 0) {
      if (!/\s/u.test(text[cursor]!)) remaining--;
      cursor++;
    }
    result.push({ ...segment, text: text.slice(from, cursor) });
  }
  if (result.length) {
    const last = result[result.length - 1]!;
    result[result.length - 1] = {...last,text:last.text + text.slice(cursor)};
  }
  return result;
}

/** Preserve native renderer semantics; never manufacture word timing for an LRC line. */
export function toYoulyLyrics(document: LyricDocument): YoulyLyrics | null {
  if (!validLyricDocument(document)) return null;
  // A line-only credit or gap must not discard genuine word cues elsewhere.
  // The native renderer handles uncued lines independently without syllables.
  const hasWords = document.timing !== 'plain' && document.lines.some(line =>
    Boolean(line.segments?.length || line.vocalLayers?.some(layer => layer.segments.length)));
  // Enhanced translation/pronunciation tracks have independent line counts.
  // Attach only by unique *exact timestamp*; never assume same array index.
  const matchingAlternate = (kind: 'translation' | 'pronunciation', startMs: number | undefined): string | undefined => {
    if (startMs === undefined) return undefined;
    const matching = document.alternates?.filter(a => a.kind === kind).flatMap(a =>
      a.lines.filter(l => l.startMs === startMs));
    return matching?.length === 1 ? matching[0]?.text : undefined;
  };
  const nativeAgents: Record<string, { type: string }> = {};
  for (const agent of document.agents ?? []) {
    nativeAgents[agent.id] = { type: agent.role === 'group' || agent.role === 'bg' ? 'group' : 'person' };
  }
  const primarySinger = document.agents?.find(a => a.role === 'main')?.id;
  const data: YoulyVocalLine[] = [];
  for (const [index, line] of document.lines.entries()) {
    const next = document.lines[index + 1];
    const startMs = line.startMs ?? 0;
    const endMs = line.endMs ?? (next?.startMs !== undefined && next.startMs > startMs
      ? next.startMs : startMs + 4000);
    const converted: YoulyVocalLine = {
      text: line.text,
      element: { songPartIndex: 0, ...(primarySinger ? { singer: primarySinger } : {}) },
    };
    if (document.timing !== 'plain') {
      converted.startTime = startMs / 1000;
      converted.endTime = endMs / 1000;
    }
    const translation = matchingAlternate('translation', line.startMs);
    const romanization = matchingAlternate('pronunciation', line.startMs);
    if (translation) converted.translatedText = translation;
    if (romanization) converted.romanizedText = romanization;
    // A line sung entirely by a named guest/group is not also an uncued lead
    // line. Promote its explicit cues once, keeping the actual singer/role.
    const attributed = hasWords && !line.segments?.length ? line.vocalLayers?.find(layer =>
      withoutWhitespace(layer.segments.map(segment => segment.text).join('')) === withoutWhitespace(line.text)) : undefined;
    const mainSegments = attributed ? withLineWhitespace(line.text, attributed.segments) : line.segments;
    if (attributed) {
      converted.element.singer = attributed.agentId;
      converted.startTime = attributed.segments[0]!.startMs / 1000;
      converted.endTime = (line.endMs ?? attributed.segments.at(-1)!.endMs) / 1000;
    }
    if (hasWords && mainSegments?.length) {
      const syllables: YoulyVocalSyllable[] = mainSegments.map(segment => ({
        text: segment.text, time: segment.startMs, duration: segment.endMs - segment.startMs,
        ...(attributed && attributed.role !== 'voice' ? {isBackground: true} : {}),
      }));
      for (const layer of line.vocalLayers ?? []) {
        if (layer === attributed) continue;
        if (layer.role !== 'bg' && layer.role !== 'group') continue;
        for (const segment of layer.segments) syllables.push({
          text: segment.text, time: segment.startMs, duration: segment.endMs - segment.startMs,
          isBackground: true,
        });
      }
      converted.syllabus = syllables;
    }
    data.push(converted);
    // An explicitly attributed second vocalist gets a distinct native line,
    // preserving YouLyPlus's duet/side positioning instead of flattening it.
    if (hasWords) for (const layer of line.vocalLayers ?? []) {
      if (layer.role !== 'voice' || layer === attributed) continue;
      const first = layer.segments[0];
      const last = layer.segments[layer.segments.length - 1];
      if (!first || !last) continue;
      data.push({
        text: layer.segments.map(seg => seg.text).join(''),
        startTime: first.startMs / 1000, endTime: last.endMs / 1000,
        element: {songPartIndex: 0, singer: layer.agentId},
        syllabus: layer.segments.map(seg => ({text: seg.text, time: seg.startMs, duration: seg.endMs - seg.startMs})),
      });
    }
  }
  return {
    type: hasWords ? 'Word' : document.timing === 'plain' ? 'None' : 'Line',
    data,
    metadata: { source: document.attribution,
      ...(Object.keys(nativeAgents).length ? { agents: nativeAgents } : {}) },
  };
}

export interface MonotonicLyricsClock {
  getTimeSeconds(): number;
  update(ms: number | null, wallTime?: number): void;
  reset(ms: number | null, wallTime?: number): void;
}

/** Fractional-second projection between coarse station updates; no Icecast seeking. */
export function createMonotonicLyricsClock(): MonotonicLyricsClock {
  let startMs: number | null = null;
  let anchoredAt = 0;
  const clock = {
    reset(ms: number | null, now: number = performance.now()) {
      startMs = ms;
      anchoredAt = now;
    },
    update(ms: number | null, now: number = performance.now()) {
      if (ms === null) { clock.reset(null, now); return; }
      const current = startMs === null ? null : startMs + (now - anchoredAt);
      // Keep fractional progress through quantized whole-second station polling.
      // Resynchronize on a genuine jump (track transition, pause or source drift).
      if (current === null || Math.abs(current - ms) > 1500) clock.reset(ms, now);
    },
    getTimeSeconds(): number {
      return startMs === null ? 0 : Math.max(0, startMs + performance.now() - anchoredAt) / 1000;
    },
  };
  return clock;
}

/** A listener-time radio clock, with the station's advertised buffer already
 * incorporated into startedAt. Unlike the hero's integer elapsed readout this
 * calculation is continuously evaluated by the native animation loop. */
export function liveRadioLyricsPositionMs(
  startedAt: number | null, pausedAt: number | null, durationSeconds: number | null, now: number,
): number | null {
  if (startedAt === null || !Number.isFinite(startedAt) || startedAt > now + 1000) return null;
  const effectiveNow = pausedAt !== null && Number.isFinite(pausedAt) ? Math.min(now, pausedAt) : now;
  const elapsed = Math.max(0, effectiveNow - startedAt);
  if (durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > 0 &&
      elapsed > (durationSeconds + 30) * 1000) return null;
  return elapsed;
}
