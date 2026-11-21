import type { NowPlaying, QueueItem } from './types.js';

/** Queue tokens are ephemeral and must not survive a controller restart. */
export function queueItemForPersistence(item: QueueItem): Omit<QueueItem, 'queueToken'> {
  const { queueToken: _privateToken, ...persisted } = item;
  return persisted;
}

/** Token-only audit eligibility; playback's legacy metadata matcher is separate. */
export function exactV2StartToken(
  np: NowPlaying | null,
  current: QueueItem | null,
  upcoming: readonly QueueItem[],
  nowMs = Date.now(),
): string | null {
  if (!np || np.subwave_clip === true || np.subwave_clip === '1') return null;
  const token = np.subwave_queue_token;
  if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return null;
  const at = Number(np.timestamp);
  const age = nowMs / 1000 - at;
  if (!Number.isFinite(at) || age < -5 || age > 30) return null;
  const item = current?.queueToken === token ? current : upcoming.find(row => row.queueToken === token);
  return item?.sent && item.aiPicked ? token : null;
}
