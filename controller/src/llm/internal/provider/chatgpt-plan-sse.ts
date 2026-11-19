// The ChatGPT plan Responses endpoint is always streamed. Never expose partial
// decisions: a 200 response can still end in response.failed or be interrupted.
// This parser is deliberately independent of the provider registry while the
// integration is under development.

export class PlanStreamError extends Error {
  providerDiagnostic?: ChatGptPlanFailureDiagnostic;

  constructor(
    readonly code: string,
    readonly statusCode?: number,
    readonly terminalEventKind?: ChatGptPlanTerminalEvent,
    readonly incompleteReason: ChatGptPlanIncompleteReason = 'unknown',
    readonly providerErrorCode: string | null = null,
  ) {
    super(`ChatGPT plan stream: ${code}`);
    this.name = 'PlanStreamError';
  }
}

export type ChatGptPlanTerminalEvent =
  | 'response.incomplete'
  | 'response.failed'
  | 'error'
  | 'stream_ended_without_terminal';

export type ChatGptPlanIncompleteReason = 'max_output_tokens' | 'content_filter' | 'unknown';
export type ChatGptPlanFailureClass =
  | 'provider_response_incomplete'
  | 'provider_response_failed'
  | 'provider_error'
  | 'stream_ended_without_terminal';

export interface ChatGptPlanFailureDiagnostic {
  provider: 'chatgpt-plan';
  model: string;
  classification: ChatGptPlanFailureClass;
  terminalEventKind: ChatGptPlanTerminalEvent;
  incompleteReason: ChatGptPlanIncompleteReason;
  providerErrorCode: string | null;
  providerStatus: number | null;
  elapsedMs: number;
  toolCallCount: number;
  retryRecoveryAttempted: boolean;
}

const MAX_BYTES = 4 * 1024 * 1024;
const INCOMPLETE_REASONS = new Set<ChatGptPlanIncompleteReason>(['max_output_tokens', 'content_filter']);

function safeCode(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 80 && /^[a-z0-9_.-]+$/i.test(value)
    ? value : null;
}

function safeStatus(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  return null;
}

export async function readPlanCompletion(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  maxBytes = MAX_BYTES,
): Promise<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  let complete: Record<string, unknown> | undefined;
  let failure: PlanStreamError | undefined;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });

  function event(block: string) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw new PlanStreamError('invalid_event'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlanStreamError('invalid_event');
    const parsed = value as Record<string, unknown>;
    if (parsed.type === 'response.failed' || parsed.type === 'response.incomplete' || parsed.type === 'error') {
      const response = parsed.response as Record<string, unknown> | undefined;
      const error = response?.error as Record<string, unknown> | undefined;
      const providerErrorCode = safeCode(error?.code ?? parsed.code);
      const code = providerErrorCode ?? parsed.type;
      const rawReason = (response?.incomplete_details as Record<string, unknown> | undefined)?.reason;
      const incompleteReason = typeof rawReason === 'string' && INCOMPLETE_REASONS.has(rawReason as ChatGptPlanIncompleteReason)
        ? rawReason as ChatGptPlanIncompleteReason
        : 'unknown';
      const terminalEventKind = parsed.type as Exclude<ChatGptPlanTerminalEvent, 'stream_ended_without_terminal'>;
      failure = new PlanStreamError(
        code,
        safeStatus(error?.status, parsed.status, response?.status_code) ?? undefined,
        terminalEventKind,
        incompleteReason,
        providerErrorCode,
      );
    } else if (parsed.type === 'response.completed') {
      if (!parsed.response || typeof parsed.response !== 'object' || Array.isArray(parsed.response)) {
        throw new PlanStreamError('invalid_completion');
      }
      complete = parsed.response as Record<string, unknown>;
    }
  }

  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new PlanStreamError('stream_too_large');
      buffer += decoder.decode(value, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        event(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) event(buffer);
    signal?.throwIfAborted();
    if (failure) throw failure;
    if (!complete) {
      throw new PlanStreamError('incomplete_stream', undefined, 'stream_ended_without_terminal');
    }
    return complete;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
