/**
 * Outbound HTTP for the Zen adapter — port of httpclient.go + executor.go
 * request loop: per-request proxy resolution, header timeout, SSE line parsing.
 * Retry/attempt looping lives in the adapter (needs fresh session ids).
 */
import { Agent, ProxyAgent, request as undiciRequest } from 'undici';
import { chatUrl, zenHeaders, truncateBody, ERROR_BODY_LIMIT } from './zen.js';
import { ocID } from './oc-id.js';

/** Fresh session id per attempt (reuse ⇒ upstream 403 outside-OpenCode). */
export const newSessionID = () => ocID('ses', true);
export const newMsgID = () => ocID('msg', false);

/**
 * Resolve the proxy for one request (port of httpclient.go).
 * `direct`/`none`/`off` (case-insensitive) → null (no proxy).
 */
export function resolveProxyUrl(configProxy) {
  const value = String(configProxy ?? '').trim();
  if (!value) return null;
  if (['direct', 'none', 'off'].includes(value.toLowerCase())) return null;
  return value;
}

// --- egress fallback (port of httpclient.go 0.1.2) --------------------------
//
// The free tier refuses whole address ranges, not credentials: a datacenter
// proxy exit answers every free model with 403 FreeTierError while the local
// ISP address answers 200. The reaction is to change egress, not to give up:
// a refused request suspends the proxy and the next attempt dials direct.

const PROXY_BLOCK_UNTIL = { value: 0 };

/** Suspend the proxy egress for cooldownMs; log only on transition (Go markProxyBlocked). */
export function markProxyBlocked(cooldownMs, reason, logger) {
  const now = Date.now();
  const previous = PROXY_BLOCK_UNTIL.value;
  PROXY_BLOCK_UNTIL.value = now + cooldownMs;
  if (previous === 0 || previous <= now) {
    logger?.warn?.(`zen egress: ${reason} — dialing direct for ${Math.round(cooldownMs / 1000)}s`);
  }
}

/** Whether the proxy is currently suspended in favour of a direct connection. */
export function proxyEgressBlocked() {
  return PROXY_BLOCK_UNTIL.value !== 0 && Date.now() < PROXY_BLOCK_UNTIL.value;
}

/** Lift the suspension (tests; expiry clears it in production). */
export function clearProxyBlock() {
  PROXY_BLOCK_UNTIL.value = 0;
}

/** Whether the next request will actually use the proxy. */
export function dialsThroughProxy(configProxy) {
  return resolveProxyUrl(configProxy) !== null && !proxyEgressBlocked();
}

/** Human description of the current egress path (Go transportLabel). */
export function egressLabel(configProxy) {
  const raw = resolveProxyUrl(configProxy);
  if (!raw) return 'direct (no proxy, configured)';
  if (proxyEgressBlocked()) return 'direct (proxy suspended: the free tier refused the proxy address)';
  return raw;
}

/**
 * Whether an upstream body carries the free tier's identity error. Only the
 * type marker is checked: the surrounding message differs between the two
 * variants ("only from within OpenCode" vs "abusive traffic from this IP").
 */
export function isFreeTierBody(text) {
  return typeof text === 'string' && text.includes('FreeTierError');
}

/** Cooldowns (Go freeTierCooldown / proxyDownCooldown). */
export const FREE_TIER_COOLDOWN_MS = 10 * 60 * 1000;
export const PROXY_DOWN_COOLDOWN_MS = 5 * 60 * 1000;

export function dialAgent(proxyUrl, dialTimeoutMs) {
  if (!proxyUrl) return new Agent({ connect: { timeout: dialTimeoutMs } });
  return new ProxyAgent(proxyUrl, { connect: { timeout: dialTimeoutMs } });
}

async function closeQuietly(body) {
  try {
    await body?.cancel?.();
  } catch {}
}

/**
 * One POST to /v1/chat/completions. Never retries internally — the adapter's
 * generator owns attempt looping (fresh session id per attempt).
 *
 * Egress selection (0.1.2): the attempt dials direct when the proxy is
 * suspended (proxyEgressBlocked) or forceDirect is set. A transport-level
 * failure while dialing through the proxy is tagged `error.phase='dial'` so the
 * adapter can suspend the proxy; an HTTP failure is tagged `error.phase='http'`
 * with `error.status`.
 *
 * @param {object} args
 * @param {object} args.body upstream JSON body (already rewritten)
 * @param {object} args.config resolved plugin config
 * @param {AbortSignal} args.signal combined consumer+deadline signal
 * @param {number} args.headerTimeoutMs separate TTFB timeout
 * @param {boolean} [args.forceDirect] dial direct this attempt regardless of egress state
 * @param {{headersReceived: boolean}} [args.state] set once response headers arrived
 * @returns {AsyncGenerator<string>} raw SSE `data:` payload strings
 */
export async function* postChatCompletion({ body, config, signal, headerTimeoutMs, forceDirect, state }) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const proxyUrl = forceDirect ? null : resolveProxyUrl(config.proxy);
  const dispatcher = dialAgent(proxyUrl, config.dialTimeoutMs);
  const headers = zenHeaders(bytes, newSessionID(), newMsgID);

  let response;
  try {
    response = await undiciRequest(chatUrl(config.baseUrl), {
      method: 'POST',
      body: bytes,
      headers,
      dispatcher,
      signal,
      // Go sets DisableCompression: true — identity is part of the gate.
      headersTimeout: headerTimeoutMs,
      bodyTimeout: 0,
      maxRedirections: 0,
    });
  } catch (error) {
    dispatcher.close?.().catch(() => {});
    if (proxyUrl) error.phase = 'dial'; // failure happened on the proxy path
    throw error;
  }
  if (state) state.headersReceived = true;

  try {
    if (response.statusCode >= 400) {
      let text = '';
      try {
        text = await response.body.text();
      } catch {}
      await closeQuietly(response.body);
      const err = new Error(`upstream http ${response.statusCode}: ${truncateBody(text.slice(0, ERROR_BODY_LIMIT))}`);
      err.status = response.statusCode;
      err.phase = 'http';
      err.bodyText = text;
      throw err;
    }
    yield* parseSseData(response.body);
  } finally {
    await closeQuietly(response.body);
    dispatcher.close?.().catch(() => {});
  }
}

/**
 * Port of executor.go upstreamSSEFrame iteration: yield only `data:` payload
 * lines; ignore comments/blank/event lines; stop silently at `[DONE]`.
 * @param {AsyncIterable<Uint8Array>} bodyStream
 * @returns {AsyncGenerator<string>} JSON payload strings (without `data: `)
 */
export async function* parseSseData(bodyStream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of bodyStream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineAt = buffer.indexOf('\n');
    while (newlineAt !== -1) {
      const line = buffer.slice(0, newlineAt).replace(/\r$/, '');
      buffer = buffer.slice(newlineAt + 1);
      const payload = sseDataPayload(line);
      if (payload !== undefined) yield payload;
      newlineAt = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    const payload = sseDataPayload(buffer.replace(/\r$/, ''));
    if (payload !== undefined) yield payload;
  }
}

/** `data: X` → X; everything else (blank/comment/event/`data: [DONE]`) → undefined. */
function sseDataPayload(line) {
  if (!line.startsWith('data:')) return undefined;
  const payload = line.slice(5);
  if (payload.trim() === '[DONE]') return undefined;
  return payload.startsWith(' ') ? payload.slice(1) : payload;
}

/**
 * Combined abort: consumer signal + overall deadline (port of zenRequestTimeout).
 * The timer aborts with a TimeoutError reason; a consumer abort forwards its reason.
 */
export function withDeadline(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('request deadline exceeded', 'TimeoutError')),
    timeoutMs,
  );
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** Abort-aware backoff sleep; resolves (does not throw) when aborted. */
export function sleepMs(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
