import type { NowPlayingTrack, QueueEntry, SessionTurn, StationState } from '../../../lib/types';
import { splitAudibleTurns, turnClass, turnText } from '../../../lib/sessionFeed';

export type AirLogRow =
  | { kind: 'track'; key: string; t?: string; entry: QueueEntry; reason?: string }
  | { kind: 'voice'; key: string; t?: string | number; text: string; speaker?: string };

function timestampMs(value: string | number | undefined): number {
  const at = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(at) ? at : 0;
}

function entryTime(entry: QueueEntry): string | undefined {
  return entry.startedAt ?? entry.t ?? (typeof entry.queuedAt === 'string' ? entry.queuedAt : undefined);
}

function matches(entry: QueueEntry | null | undefined, track: NowPlayingTrack): boolean {
  if (!entry) return false;
  if (entry.subsonic_id && track.subsonic_id) return entry.subsonic_id === track.subsonic_id;
  return entry.title === track.title && entry.artist === track.artist;
}

export function buildAirHistory({
  state, nowPlaying, messages, leadMs, nowMs,
}: {
  state: StationState;
  nowPlaying: NowPlayingTrack | null;
  messages: SessionTurn[];
  leadMs: number;
  nowMs: number;
}) {
  const history = state.history ?? [];
  // During the listener buffer's metadata hold, the audible song may already
  // be in live-edge history. Give it NOW once, rather than duplicate it below.
  const airing = nowPlaying
    ? matches(state.current, nowPlaying) ? state.current
      : history.find(entry => matches(entry, nowPlaying))
    : null;
  const current: QueueEntry | null = nowPlaying ? { ...airing, ...nowPlaying } : null;
  const legacyReasons = new Map<string, string>();
  for (const turn of messages) {
    if (turn.role === 'dj' && turn.kind === 'pick' && typeof turn.meta?.trackId === 'string' && turn.text?.trim()) {
      legacyReasons.set(turn.meta.trackId, turn.text.trim());
    }
  }
  const reasonFor = (entry: QueueEntry | null | undefined) => entry?.reason
    ?? (state.airMessages == null && entry?.subsonic_id ? legacyReasons.get(entry.subsonic_id) : undefined);
  const rows: AirLogRow[] = history.filter(entry => entry !== airing).map((entry, index) => ({
    kind: 'track',
    key: `track-${entry.subsonic_id ?? entry.title ?? index}-${entryTime(entry) ?? index}`,
    t: entryTime(entry),
    entry,
    reason: reasonFor(entry),
  }));
  const speech = splitAudibleTurns(state.airMessages ?? messages, leadMs, nowMs).visible;
  for (const [index, turn] of speech.entries()) {
    if (turnClass(turn) !== 'voice') continue;
    const text = turnText(turn).trim();
    if (!text) continue;
    rows.push({
      kind: 'voice', key: `voice-${turn.t ?? index}-${index}`,
      t: typeof turn.meta?.airedAt === 'string' ? turn.meta.airedAt : turn.t,
      text,
      speaker: typeof turn.meta?.personaName === 'string' ? turn.meta.personaName : undefined,
    });
  }
  return {
    current,
    currentReason: reasonFor(current),
    next: state.upcoming?.[0] ?? null,
    nextReason: reasonFor(state.upcoming?.[0]),
    rows: rows.sort((a, b) => timestampMs(b.t) - timestampMs(a.t)),
  };
}
