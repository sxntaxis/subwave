// Experimental SIWC Responses model. It is intentionally not registered until
// credential storage, failover, settings, and end-to-end tests are complete.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { readPlanCompletion, PlanStreamError } from './chatgpt-plan-sse.js';

const NAMESPACE = 'subwave';
const ADMISSION_CODES = new Set([
  'subscription_sharing_user_not_eligible',
  'subscription_sharing_route_not_supported',
  'chatpass_v2_scope_not_authorized',
  'chatpass_v2_invalid_authorization_context',
]);
type Obj = Record<string, unknown>;
const record = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};

function encodePrompt(prompt: LanguageModelV4CallOptions['prompt']): Obj[] {
  const input: Obj[] = [];
  for (const message of prompt) {
    if (message.role === 'system') {
      input.push({ role: 'developer', content: message.content });
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text') {
        input.push({ role: message.role, content: part.text });
      } else if (part.type === 'tool-call') {
        input.push({ type: 'function_call', name: part.toolName, namespace: NAMESPACE, call_id: part.toolCallId, arguments: JSON.stringify(part.input) });
      } else if (part.type === 'tool-result') {
        const result = part.output;
        let output: string;
        if (result.type === 'text' || result.type === 'error-text') output = result.value;
        else if (result.type === 'json' || result.type === 'error-json') output = JSON.stringify(result.value);
        else if (result.type === 'execution-denied') output = result.reason || 'Tool execution denied';
        else throw new PlanStreamError('unsupported_tool_result');
        input.push({ type: 'function_call_output', call_id: part.toolCallId, output });
      } else if (part.type === 'reasoning') {
        const meta = record(part.providerOptions?.chatgptPlan);
        if (typeof meta.encryptedContent !== 'string' || typeof meta.itemId !== 'string') {
          throw new PlanStreamError('missing_reasoning_continuation');
        }
        input.push({ type: 'reasoning', id: meta.itemId, encrypted_content: meta.encryptedContent, summary: part.text ? [{ type: 'summary_text', text: part.text }] : [] });
      } else {
        throw new PlanStreamError('unsupported_prompt_part');
      }
    }
  }
  return input;
}

export function planRequest(model: string, options: LanguageModelV4CallOptions): Obj {
  const body: Obj = {
    model, input: encodePrompt(options.prompt), store: false, stream: true,
    include: ['reasoning.encrypted_content'],
  };
  let tools = options.tools || [];
  if (tools.some(tool => tool.type !== 'function')) throw new PlanStreamError('unsupported_provider_tool');
  if (options.toolChoice?.type === 'tool') {
    const name = options.toolChoice.toolName;
    tools = tools.filter(tool => tool.name === name);
    if (tools.length !== 1) throw new PlanStreamError('missing_forced_tool');
  }
  if (tools.length) {
    body.tools = [{ type: 'namespace', name: NAMESPACE, description: 'SUB/WAVE tools', tools: tools.map(tool => {
      if (tool.type !== 'function') throw new PlanStreamError('unsupported_provider_tool');
      return { type: 'function', name: tool.name, description: tool.description || '', parameters: tool.inputSchema, strict: tool.strict ?? false };
    }) }];
    if (options.toolChoice) body.tool_choice = options.toolChoice.type === 'tool' ? 'required' : options.toolChoice.type;
  }
  if (options.responseFormat?.type === 'json') {
    body.text = { format: options.responseFormat.schema
      ? { type: 'json_schema', name: options.responseFormat.name || 'response', schema: options.responseFormat.schema, strict: true }
      : { type: 'json_object' } };
  }
  return body;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function errorCode(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) return undefined;
      text += decoder.decode(value, { stream: true });
    }
    const data = record(JSON.parse(text + decoder.decode()));
    const candidate = record(data.error).code;
    return typeof candidate === 'string' && /^[a-z0-9_.-]{1,100}$/i.test(candidate) ? candidate : undefined;
  } catch { return undefined; } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function planResult(response: Obj): LanguageModelV4GenerateResult {
  if (response.status !== 'completed' || !Array.isArray(response.output)) throw new PlanStreamError('invalid_completion');
  const content: LanguageModelV4Content[] = [];
  for (const raw of response.output) {
    const item = record(raw);
    if (item.type === 'message') {
      if (!Array.isArray(item.content)) throw new PlanStreamError('invalid_message');
      for (const rawPart of item.content) {
        const part = record(rawPart);
        if (part.type !== 'output_text' || typeof part.text !== 'string') throw new PlanStreamError('unsupported_response_part');
        content.push({ type: 'text', text: part.text });
      }
    } else if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string' || (item.namespace != null && item.namespace !== NAMESPACE)) throw new PlanStreamError('invalid_tool_call');
      content.push({ type: 'tool-call', toolCallId: item.call_id, toolName: item.name, input: item.arguments });
    } else if (item.type === 'reasoning') {
      if (typeof item.id !== 'string' || typeof item.encrypted_content !== 'string') throw new PlanStreamError('missing_reasoning_continuation');
      const summary = Array.isArray(item.summary) ? item.summary.map(s => record(s).text).filter((s): s is string => typeof s === 'string').join('\n') : '';
      content.push({ type: 'reasoning', text: summary, providerMetadata: { chatgptPlan: { itemId: item.id, encryptedContent: item.encrypted_content } } });
    } else throw new PlanStreamError('unsupported_response_item');
  }
  const usage = record(response.usage);
  const input = number(usage.input_tokens);
  const output = number(usage.output_tokens);
  const cached = number(record(usage.input_tokens_details).cached_tokens);
  const reasoning = number(record(usage.output_tokens_details).reasoning_tokens);
  return {
    content,
    finishReason: { unified: content.some(part => part.type === 'tool-call') ? 'tool-calls' : 'stop', raw: 'completed' },
    usage: {
      inputTokens: { total: input, noCache: input != null && cached != null ? input - cached : undefined, cacheRead: cached, cacheWrite: undefined },
      outputTokens: { total: output, text: output != null && reasoning != null ? output - reasoning : undefined, reasoning },
    },
    warnings: [],
  };
}

export function createPlanModel(
  modelId: string,
  credential: () => Promise<string>,
  fetchImpl: typeof fetch = fetch,
  onUnauthorized?: (rejectedToken: string) => Promise<void>,
  onBlock?: (rejectedToken: string, reason: 'subscription_sharing_usage_limit_exceeded' | 'admission_denied') => Promise<void>,
): LanguageModelV4 {
  let quotaUntil = 0;
  let unavailableUntil = 0;
  let unavailableStatus = 404;
  let unavailableCode = 'model_unavailable';
  const generateOnce = async (options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> => {
    if (Date.now() < quotaUntil) throw new PlanStreamError('subscription_sharing_usage_limit_exceeded');
    if (Date.now() < unavailableUntil) throw new PlanStreamError(unavailableCode, unavailableStatus);
    const body = planRequest(modelId, options);
    options.abortSignal?.throwIfAborted();
    const token = await credential();
    options.abortSignal?.throwIfAborted();
    const timeout = AbortSignal.timeout(90_000);
    const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, timeout]) : timeout;
    const providerStartedAt = Date.now();
    const toolCallCount = Math.min(1000, options.prompt.reduce((count, message) =>
      count + (Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'tool-call').length
        : 0), 0));
    const response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal,
    });
    if (!response.ok) {
      const code = await errorCode(response) || `http_${response.status}`;
      if (response.status === 401 && onUnauthorized) await onUnauthorized(token).catch(() => {});
      // Admission refusals and missing models do not improve by asking the
      // identical question again in djObject's recovery path or on every track.
      if (response.status === 403 || response.status === 404) {
        let persisted = false;
        if (response.status === 403 && onBlock) {
          try { await onBlock(token, 'admission_denied'); persisted = true; } catch { /* use local backoff */ }
        }
        unavailableUntil = persisted ? 0 : Date.now() + 15 * 60_000;
        unavailableStatus = response.status;
        unavailableCode = code;
      }
      if (code === 'subscription_sharing_usage_limit_exceeded') {
        let persisted = false;
        if (onBlock) {
          try { await onBlock(token, 'subscription_sharing_usage_limit_exceeded'); persisted = true; } catch { /* use local backoff */ }
        }
        quotaUntil = persisted ? 0 : Date.now() + 15 * 60_000;
      } else if (code === 'subscription_sharing_usage_unavailable') quotaUntil = Date.now() + 15 * 60_000;
      throw new PlanStreamError(code, response.status);
    }
    if (!response.body) throw new PlanStreamError('missing_stream');
    try {
      return planResult(await readPlanCompletion(response.body, signal));
    } catch (error) {
      if (error instanceof PlanStreamError && error.terminalEventKind) {
        error.providerDiagnostic = {
          provider: 'chatgpt-plan',
          model: /^[A-Za-z0-9._:/-]{1,100}$/.test(modelId) ? modelId : 'unknown',
          classification: error.terminalEventKind === 'response.incomplete'
            ? 'provider_response_incomplete'
            : error.terminalEventKind === 'response.failed'
              ? 'provider_response_failed'
              : error.terminalEventKind === 'error'
                ? 'provider_error'
                : 'stream_ended_without_terminal',
          terminalEventKind: error.terminalEventKind,
          incompleteReason: error.incompleteReason,
          providerErrorCode: error.providerErrorCode,
          providerStatus: error.statusCode ?? null,
          elapsedMs: Math.min(600_000, Math.max(0, Date.now() - providerStartedAt)),
          toolCallCount,
          retryRecoveryAttempted: false,
        };
      }
      if (error instanceof PlanStreamError && error.code === 'subscription_sharing_usage_limit_exceeded') {
        let persisted = false;
        if (onBlock) {
          try { await onBlock(token, 'subscription_sharing_usage_limit_exceeded'); persisted = true; } catch { /* use local backoff */ }
        }
        quotaUntil = persisted ? 0 : Date.now() + 15 * 60_000;
      } else if (error instanceof PlanStreamError && ADMISSION_CODES.has(error.code)) {
        let persisted = false;
        if (onBlock) {
          try { await onBlock(token, 'admission_denied'); persisted = true; } catch { /* use local backoff */ }
        }
        if (!persisted) {
          unavailableUntil = Date.now() + 15 * 60_000;
          unavailableStatus = 403;
          unavailableCode = error.code;
        }
      } else if (error instanceof PlanStreamError && error.code === 'subscription_sharing_usage_unavailable') quotaUntil = Date.now() + 15 * 60_000;
      throw error;
    }
  };
  // A terminal response.incomplete with NO declared reason may be a temporary
  // provider failure. Retry only the affected model *step*, using the exact
  // same prompt and preserved tool results. Do not rerun the whole DJ agent:
  // doing so could repeat discovery tools and lose grounded evidence.
  // Explicit token exhaustion, filtering, quota/auth, and deadline failures
  // are not retryable by replaying the identical request.
  const generate = async (options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> => {
    try {
      return await generateOnce(options);
    } catch (error) {
      if (!(error instanceof PlanStreamError)
        || error.terminalEventKind !== 'response.incomplete'
        || error.incompleteReason !== 'unknown'
        || error.code !== 'response.incomplete'
        || options.abortSignal?.aborted) throw error;
      // The caller's shared phase deadline owns this recovery. A provider
      // timeout is not an invitation to extend its allowed wall-clock time.
      console.warn('[chatgpt-plan] incomplete model step without declared reason; retrying once');
      try {
        return await generateOnce(options);
      } catch (retryError) {
        if (retryError instanceof PlanStreamError && retryError.providerDiagnostic) {
          retryError.providerDiagnostic.retryRecoveryAttempted = true;
        }
        throw retryError;
      }
    }
  };
  return {
    specificationVersion: 'v4', provider: 'chatgpt-plan', modelId, supportedUrls: {},
    doGenerate: generate,
    async doStream(options) {
      const result = await generate(options);
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: result.warnings });
          let id = 0;
          for (const part of result.content) {
            if (part.type === 'text' || part.type === 'reasoning') {
              const name = String(id++);
              controller.enqueue({ type: `${part.type}-start`, id: name, providerMetadata: part.providerMetadata });
              controller.enqueue({ type: `${part.type}-delta`, id: name, delta: part.text });
              controller.enqueue({ type: `${part.type}-end`, id: name });
            } else if (part.type === 'tool-call') controller.enqueue(part);
          }
          controller.enqueue({ type: 'finish', finishReason: result.finishReason, usage: result.usage });
          controller.close();
        },
      });
      return { stream };
    },
  };
}
