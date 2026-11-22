// Factual, compact musical memory distinct from a chat transcript. Only tracks
// that actually began airing belong here; queued picks are never past plays.
// No guessed tempo, section names, transition scores or Essentia probabilities.
import type { QueueItem } from '../queue/types.js';

export function recentMusicalArc(
  current: QueueItem | null, history: readonly QueueItem[], limit = 12,
): Array<{ title: string; artist: string | null; bpm?: number; key?: string; energy?: string;
  moods?: string[] }> {
  const result: Array<{ title: string; artist: string | null; bpm?: number; key?: string;
    energy?: string; moods?: string[] }> = [];
  for (const item of [current, ...history]) {
    if (result.length >= Math.max(0, Math.min(20, limit))) break;
    if (!item?.startedAt || !item.track?.title) continue;
    const track = item.track;
    const bpm = Number(track.bpm);
    const key = typeof track.musicalKey === 'string' ? track.musicalKey
      : typeof track.musical_key === 'string' ? track.musical_key : null;
    const energy = typeof track.energy === 'string' ? track.energy : null;
    const moods = Array.isArray(track.moods) ? track.moods.filter((m): m is string => typeof m === 'string').slice(0, 8) : [];
    result.push({ title: String(track.title), artist: typeof track.artist === 'string' ? track.artist : null,
      ...(Number.isFinite(bpm) && bpm > 0 && bpm < 400 ? { bpm } : {}),
      ...(key ? { key } : {}), ...(energy ? { energy } : {}),
      ...(moods.length ? { moods } : {}),
    });
  }
  return result;
}
