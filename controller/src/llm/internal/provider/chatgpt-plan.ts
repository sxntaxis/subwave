import { CHATGPT_PLAN_DIR } from '../../../config.js';
import { PlanSession } from './chatgpt-plan-session.js';
import { PlanStreamError } from './chatgpt-plan-sse.js';

let session: PlanSession | undefined;
export function planSession(): PlanSession {
  if (!CHATGPT_PLAN_DIR) throw new PlanStreamError('session_directory_unconfigured');
  session ??= new PlanSession(CHATGPT_PLAN_DIR);
  return session;
}

export async function planModels(signal?: AbortSignal): Promise<string[]> {
  const session = planSession();
  const token = await session.getAuthorizedCredential();
  signal?.throwIfAborted();
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${token}` }, signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) await session.markReauthRequired(token).catch(() => {});
    throw new PlanStreamError('model_discovery_failed', response.status);
  }
  const data = await response.json() as { models?: unknown };
  if (!Array.isArray(data.models)) throw new PlanStreamError('invalid_model_catalog');
  return data.models
    .filter(item => item && item.visibility === 'list' && typeof item.slug === 'string' && item.slug.length <= 100)
    .map(item => item.slug as string);
}
