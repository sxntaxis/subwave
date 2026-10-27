import type { LyricDocument, LyricLine } from './lyricsModel';

/**
 * Synthetic, author-written text for local visual QA only. Never shipped as a
 * listener lyric response; no existing artist/song is represented by this text.
 */
export type LyricsPreviewMode = 'plain' | 'line' | 'word';

const originalText = [
  'Between the wires, a quiet morning',
  'The signal travels through the rain',
  'A thousand windows learn to listen',
  'And distant streets begin again',
  'The quiet carries all the colors',
  'A city breathing in the light',
];

function wordSegments(text: string, startMs: number) {
  const pieces = text.match(/\S+\s*/g) ?? [];
  return pieces.map((piece, index) => ({
    text: piece,
    startMs: startMs + index * 480,
    endMs: startMs + (index + 1) * 480,
  }));
}

export function createLyricsPreview(mode: LyricsPreviewMode): LyricDocument {
  const lines: LyricLine[] = originalText.map((text, index) => {
    const startMs = 1800 + index * 4800;
    if (mode === 'plain') return { id: `synthetic-${index}`, text };
    if (mode === 'line') return { id: `synthetic-${index}`, text, startMs };
    return {
      id: `synthetic-${index}`,
      text,
      startMs,
      endMs: startMs + 4400,
      segments: wordSegments(text, startMs),
    };
  });
  return { id: `synthetic-lyrics-${mode}`, timing: mode, language: 'en', lines };
}
