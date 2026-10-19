/**
 * The Zen adapter — the DSH-side port of plugin.go's executor, expressed as a
 * dsh-llm `LlmAdapter`. The adapter owns the OpenCode Zen protocol: gate
 * headers, forced streaming, tool-gate mapping, retry with fresh session ids,
 * and StreamChunk translation.
 *
 * StreamChunk vocabulary (host contract):
 *   {type:'block-start', index, blockType:'text'|'reasoning'|'tool-call'}
 *   {type:'text-delta', index, text} / {type:'reasoning-delta', index, text}
 *   {type:'tool-call-delta', index, id?, name?, argumentsDelta}
 *   {type:'block-end', index, block:{type:'text',text}|{type:'reasoning',text}|{type:'tool-call',id,name,arguments}}
 *   {type:'usage', usage:{inputTokens, outputTokens, totalTokens, ...}}
 *   exactly one terminal {type:'finish', reason:{kind:...}|{kind:'error'|'aborted', failure:{message, code, ...}}}
 */
import { postChatCompletion, withDeadline, sleepMs, markProxyBlocked, dialsThroughProxy, isFreeTierBody, resolveProxyUrl, dialAgent, FREE_TIER_COOLDOWN_MS, PROXY_DOWN_COOLDOWN_MS } from './http.js';
import { modelsUrl, normalizeUpstreamModel, zenChatBody, truncateBody, retryableStatus, USER_AGENT } from './zen.js';
import { upstreamToolList, DeltaToolFilter } from './tools.js';
import { ZEN_FREE_MODELS, ZEN_RETIRED_MODELS, ZEN_CONTEXT_WINDOW, ZEN_MAX_OUTPUT, modelMeta, isFreeTierID, displayNameFor } from './models.js';
import { Agent, ProxyAgent, request as undiciRequest } from 'undici';

/** Stable failure codes aligned with the host taxonomy. */
export const CODE = {
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  TRANSPORT: 'TRANSPORT',
  SERVER: 'SERVER',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  UNKNOWN: 'UNKNOWN',
};

/**
 * Lightweight LlmError twin. The host's normalizeLlmFailure trusts a thrown
 * Error carrying OWN data properties `code` (string) and `failure`
 * ({message, code, status?, providerRetryAfterMs?, requestId?}) when they
 * agree — no instanceof against the host class is needed.
 */
export class LlmError extends Error {
  constructor(message, code, opts = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.failure = Object.freeze({
      message,
      code,
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      ...(opts.providerRetryAfterMs !== undefined ? { providerRetryAfterMs: opts.providerRetryAfterMs } : {}),
      ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
    });
  }
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return CODE.AUTH;
  if (status === 429) return CODE.RATE_LIMIT;
  if (status >= 500) return CODE.SERVER;
  return CODE.UNKNOWN; // 400/404/410 etc.
}

function statusError(status, bodyText) {
  return new LlmError(`upstream http ${status}: ${truncateBody(bodyText)}`, classifyStatus(status), { status });
}

/** Join text blocks of a message into one wire string (images/files are already placeholders). */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => (block?.type === 'text' || block?.type === undefined) && typeof block?.text === 'string')
    .map((block) => block.text)
    .join('');
}

function blocksOf(message) {
  return Array.isArray(message?.content) ? message.content : [];
}

/**
 * Project host Message[] into OpenAI wire messages. Host shape:
 * {role: 'user'|'assistant'|'system'|'developer'|'tool', content: Block[], toolCallId?}.
 * developer messages carry tool bookkeeping the host already folded into the
 * tool list — drop them (matches pi-ai compat.supportsDeveloperRole:false).
 */
export function serializeMessages(messages) {
  const wire = [];
  for (const message of messages ?? []) {
    switch (message?.role) {
      case 'system':
        wire.push({ role: 'system', content: textOf(message.content) });
        break;
      case 'developer':
        break;
      case 'user':
        wire.push({ role: 'user', content: textOf(message.content) });
        break;
      case 'assistant': {
        const entry = { role: 'assistant', content: textOf(message.content) };
        const calls = blocksOf(message).filter((block) => block?.type === 'tool-call');
        if (calls.length > 0) {
          entry.tool_calls = calls.map((block) => ({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}) },
          }));
          if (entry.content === '') entry.content = null;
        }
        wire.push(entry);
        break;
      }
      case 'tool':
        wire.push({ role: 'tool', tool_call_id: message.toolCallId, content: textOf(message.content) });
        break;
      default:
        break;
    }
  }
  return wire;
}

/** Build the client-shaped body (pre-zen-rewrite) from host stream options. */
export function serializeBody(options) {
  const body = {
    model: options.model,
    stream: false, // upstream rewrite forces true; recorded here for clarity
    messages: serializeMessages(options.messages),
  };
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    // Host declarations are flat {name, description, parameters} (pi-ai piTool,
    // DeepSeekAdapter :1726). Wire shape is accepted defensively: prefer
    // function.name when both spellings appear.
    body.tools = options.tools.map((tool) => {
      const name = tool?.function?.name ?? tool?.name;
      if (typeof name !== 'string' || name.length === 0) {
        throw new LlmError('tool declaration is missing a name', 'INVALID_REQUEST');
      }
      return {
        type: 'function',
        function: {
          name,
          description: tool?.function?.description ?? tool?.description ?? '',
          parameters: tool?.function?.parameters ?? tool?.parameters ?? { type: 'object', properties: {} },
        },
      };
    });
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  return body;
}

/**
 * One upstream attempt: rewrite body, POST, translate SSE → StreamChunk.
 * Yields translated chunks; throws LlmError on failure. Returns
 * {usageEmitted} so the retry loop knows whether bytes reached the consumer.
 */
async function* translateAttempt({ clientBody, config, signal, headerTimeoutMs, forceDirect }) {
  const { mapper, upstreamTools } = upstreamToolList(clientBody.tools);
  const upstreamModel = normalizeUpstreamModel(clientBody.model);
  const body = zenChatBody({ ...clientBody, tools: upstreamTools }, mapper, upstreamModel);
  const filter = new DeltaToolFilter(mapper);

  let sawFinish = false;
  let sawAnything = false;
  let finishReason = 'stop';
  let emittedBlocks = 0;
  let usageEmitted = false;
  // Open blocks by kind (at most one of each open at a time, like pi-ai).
  let openText = undefined;
  let openReasoning = undefined;
  let openTool = undefined;

  function* closeText() {
    if (openText !== undefined) {
      yield { type: 'block-end', index: openText.index, block: { type: 'text', text: openText.text } };
      openText = undefined;
    }
  }
  function* closeReasoning() {
    if (openReasoning !== undefined) {
      yield { type: 'block-end', index: openReasoning.index, block: { type: 'reasoning', text: openReasoning.text } };
      openReasoning = undefined;
    }
  }
  function* closeTool() {
    if (openTool !== undefined) {
      yield { type: 'block-end', index: openTool.index, block: { type: 'tool-call', id: openTool.id, name: openTool.name, arguments: openTool.args } };
      openTool = undefined;
    }
  }

  for await (const payload of postChatCompletion({ body, config, signal, headerTimeoutMs, forceDirect })) {
    sawAnything = true;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue; // tolerate non-JSON data lines (keep-alives)
    }
    if (chunk?.error) {
      const errObj = typeof chunk.error === 'object' && chunk.error !== null ? chunk.error : {};
      const message = String(errObj.message ?? (typeof chunk.error === 'string' ? chunk.error : 'upstream error'));
      const status = typeof errObj.code === 'number' && errObj.code >= 100 && errObj.code <= 599 ? errObj.code : undefined;
      throw status !== undefined ? statusError(status, message) : new LlmError(message, CODE.UNKNOWN);
    }

    const choice = chunk?.choices?.[0];
    const delta = choice?.delta ?? {};

    filter.filter(delta);

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (openReasoning !== undefined) yield* closeReasoning();
      if (openText === undefined) {
        yield { type: 'block-start', index: emittedBlocks, blockType: 'text' };
        openText = { index: emittedBlocks, text: '' };
        emittedBlocks += 1;
      }
      openText.text += delta.content;
      yield { type: 'text-delta', index: openText.index, text: delta.content };
    }

    const reasoningText = typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0 ? delta.reasoning_content : undefined;
    if (reasoningText !== undefined) {
      if (openText !== undefined) yield* closeText();
      if (openReasoning === undefined) {
        yield { type: 'block-start', index: emittedBlocks, blockType: 'reasoning' };
        openReasoning = { index: emittedBlocks, text: '' };
        emittedBlocks += 1;
      }
      openReasoning.text += reasoningText;
      yield { type: 'reasoning-delta', index: openReasoning.index, text: reasoningText };
    }

    if (Array.isArray(delta.tool_calls)) {
      if (openText !== undefined) yield* closeText();
      if (openReasoning !== undefined) yield* closeReasoning();
      for (const call of delta.tool_calls) {
        const upstreamIndex = typeof call.index === 'number' ? call.index : 0;
        if (openTool === undefined || openTool.upstreamIndex !== upstreamIndex) {
          yield* closeTool();
          yield { type: 'block-start', index: emittedBlocks, blockType: 'tool-call' };
          openTool = {
            index: emittedBlocks,
            upstreamIndex,
            id: typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${upstreamIndex}`,
            name: typeof call?.function?.name === 'string' ? call.function.name : '',
            args: '',
          };
          emittedBlocks += 1;
        }
        if (typeof call.id === 'string' && call.id.length > 0) openTool.id = call.id;
        if (typeof call?.function?.name === 'string' && call.function.name.length > 0) openTool.name = call.function.name;
        if (typeof call?.function?.arguments === 'string' && call.function.arguments.length > 0) {
          openTool.args += call.function.arguments;
          yield { type: 'tool-call-delta', index: openTool.index, id: openTool.id, name: openTool.name, argumentsDelta: call.function.arguments };
        }
      }
    }

    if (choice?.finish_reason) {
      sawFinish = true;
      if (choice.finish_reason === 'tool_calls' && !filter.sawCall) {
        finishReason = 'stop'; // every call was a dropped placeholder → collapse (Go downstreamToolFilter)
      } else if (choice.finish_reason === 'length') {
        finishReason = 'max-tokens';
      } else if (choice.finish_reason === 'tool_calls') {
        finishReason = 'tool-calls';
      } else {
        finishReason = 'stop';
      }
    }

    if (chunk?.usage && usageEmitted === false) {
      const u = chunk.usage;
      const input = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0;
      const output = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
      const cacheRead = typeof u.prompt_tokens_details?.cached_tokens === 'number' ? u.prompt_tokens_details.cached_tokens : undefined;
      yield {
        type: 'usage',
        usage: {
          inputTokens: input,
          outputTokens: output,
          totalTokens: input + output,
          ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
        },
      };
      usageEmitted = true;
    }
  }

  yield* closeText();
  yield* closeReasoning();
  yield* closeTool();

  if (!sawAnything || !sawFinish) {
    throw new LlmError('upstream stream ended without a completion payload', CODE.TRANSPORT);
  }
  if (finishReason === 'stop' && emittedBlocks === 0) {
    throw new LlmError('upstream returned no content', CODE.EMPTY_RESPONSE);
  }
  // Exactly one terminal finish per successful stream (host synthesizes
  // {kind:'error'} finishes only from thrown failures).
  yield { type: 'finish', reason: { kind: finishReason } };
}

/**
 * ZenAdapter — registered for the route ['opencodehub'].
 */
export class ZenAdapter {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.provider = 'opencodehub';
    /** @type {{ids: string[], fetchedAt: number}} directory cache */
    this.directory = { ids: [], fetchedAt: 0 };
    this.lastDirectoryLogAt = 0;
  }

  providerInfo(provider) {
    return { id: provider, name: 'OpenCode Zen (free tier)' };
  }

  providerRetryPolicy(_provider) {
    return undefined; // host default retry policy applies
  }

  /** Directory refresh (Go zenRefreshLoop semantics, pulled lazily). */
  async directoryModels() {
    const { directoryTtlMs } = this.config;
    if (Date.now() - this.directory.fetchedAt < directoryTtlMs) return this.directory.ids;
    try {
      // Share the chat path's egress decision: proxy while healthy, direct
      // while suspended (Go catalogClient shares the proxied transport).
      const proxyUrl = dialsThroughProxy(this.config.proxy) ? resolveProxyUrl(this.config.proxy) : null;
      const dispatcher = dialAgent(proxyUrl, this.config.dialTimeoutMs);
      try {
        const response = await undiciRequest(modelsUrl(this.config.baseUrl), {
          method: 'GET',
          headers: { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': USER_AGENT },
          dispatcher,
          headersTimeout: 6000,
          bodyTimeout: 6000,
          maxRedirections: 0,
        });
        if (response.statusCode >= 400) throw new Error(`status ${response.statusCode}`);
        const payload = await response.body.json();
        const ids = Array.isArray(payload?.data)
          ? payload.data.map((entry) => entry?.id).filter((id) => typeof id === 'string' && isFreeTierID(id))
          : [];
        this.directory = { ids: [...new Set(ids)], fetchedAt: Date.now() };
      } finally {
        dispatcher.close?.().catch(() => {});
      }
    } catch (error) {
      if (Date.now() - this.lastDirectoryLogAt > 30_000) {
        this.lastDirectoryLogAt = Date.now();
        this.logger?.warn?.(`zen directory refresh failed: ${error?.message ?? error}`);
      }
    }
    return this.directory.ids;
  }

  async listModels(provider) {
    const models = ZEN_FREE_MODELS.map((m) => ({ id: m.id, name: m.name }));
    const discovered = await this.directoryModels();
    for (const id of discovered) {
      if (!models.some((m) => m.id === id) && !ZEN_RETIRED_MODELS.has(id)) {
        models.push({ id, name: displayNameFor(id) });
      }
    }
    return models.map((m) => ({
      provider,
      id: m.id,
      name: m.name,
      description: 'OpenCode Zen free tier model',
      inputModalities: ['text'],
    }));
  }

  async resolveModel(provider, model, _signal) {
    const id = normalizeUpstreamModel(model);
    const meta = modelMeta(id);
    return {
      provider,
      id,
      name: meta.name,
      inputModalities: ['text'],
      context: { contextWindow: meta.contextWindow },
      defaultMaxTokens: meta.maxTokens,
    };
  }

  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal);
    return { model: resolved, stream: (options) => this.stream(options) };
  }

  /**
   * Retry loop (port of executor.go zenChatStream, 0.1.2): up to maxAttempts,
   * each attempt rebuilds the whole request with a fresh session id, linear
   * backoff. Retry only while nothing reached the consumer and the failure is
   * retryable (403/429/5xx, transport); client aborts never retry.
   *
   * Egress self-healing (0.1.2): a 403 whose body carries `FreeTierError`
   * suspends the proxy (10 min) and the very next attempt dials direct with no
   * backoff — the request itself is fine, only the exit address is refused. A
   * failed dial through the proxy (Clash off) suspends it for 5 minutes the
   * same way.
   */
  async *stream(options) {
    const deadline = withDeadline(options.signal, this.config.requestTimeoutMs);
    const headerTimeoutMs = this.config.headerTimeoutMs;
    let attempt = 0;
    let forwarded = false;

    try {
      while (attempt < this.config.maxAttempts) {
        attempt += 1;
        const proxied = dialsThroughProxy(this.config.proxy);
        try {
          for await (const chunk of translateAttempt({
            clientBody: serializeBody(options),
            config: this.config,
            signal: deadline.signal,
            headerTimeoutMs,
            forceDirect: !proxied,
          })) {
            forwarded = true;
            yield chunk;
          }
          return;
        } catch (error) {
          if (deadline.signal.aborted) {
            const reason = deadline.signal.reason;
            if (reason instanceof DOMException && reason.name === 'AbortError') {
              throw new LlmError('request aborted', CODE.ABORTED);
            }
            throw new LlmError('upstream timed out', CODE.TIMEOUT);
          }
          if (forwarded) throw error; // bytes already streamed — never replay
          if (attempt >= this.config.maxAttempts) throw error;

          // Free-tier IP block: change egress and retry immediately (no
          // backoff), like Go's zenChatStream FreeTierError branch.
          const status = error?.status ?? error?.failure?.status;
          if (status === 403 && proxied && isFreeTierBody(error?.bodyText ?? error?.message ?? '')) {
            markProxyBlocked(FREE_TIER_COOLDOWN_MS, 'free tier refused the proxy address', this.logger);
            continue;
          }
          // Dead proxy dial: suspend the proxy, then fall through to the
          // normal retry/backoff decision below.
          if (error?.phase === 'dial' && proxied) {
            markProxyBlocked(PROXY_DOWN_COOLDOWN_MS, 'proxy dial failed', this.logger);
          }

          const transportish = error?.code === CODE.TRANSPORT || status === undefined;
          if (!(transportish || retryableStatus(status))) throw error;
          this.logger?.warn?.(`zen attempt ${attempt} failed (${error?.code ?? 'unknown'}), retrying: ${truncateBody(error?.message ?? '')}`);
          await sleepMs(this.config.retryBackoffMs * attempt, deadline.signal);
        }
      }
    } finally {
      deadline.done();
    }
  }
}
