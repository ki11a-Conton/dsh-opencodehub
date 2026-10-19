/**
 * OpenCode Zen wire protocol — port of zen.go.
 *
 * Ten exact headers gate every chat request; the body is rewritten (model
 * normalized, stream forced, tools mapped, downstream-only params stripped).
 */

/** Upstream endpoints (Go zenChatURL / zenModelsURL). */
export const ZEN_CHAT_PATH = '/v1/chat/completions';
export const ZEN_MODELS_PATH = '/v1/models';

/** Go constants. */
export const USER_AGENT = 'opencode/latest/2.0.29/cli';
export const AUTH_VALUE = 'Bearer public';
export const ERROR_BODY_LIMIT = 4096;

/** Normalize an optional configured base URL into an origin-with-optional-context form. */
function normalizeBase(baseUrl) {
  const trimmed = (baseUrl ?? 'https://opencode.ai/zen').trim().replace(/\/+$/, '');
  return trimmed;
}

export function chatUrl(baseUrl) {
  return `${normalizeBase(baseUrl)}${ZEN_CHAT_PATH}`;
}

export function modelsUrl(baseUrl) {
  return `${normalizeBase(baseUrl)}${ZEN_MODELS_PATH}`;
}

/**
 * Port of zen.go ocID-based header builder. Ten headers, exact values:
 * Accept-Encoding identity, Content-Type json, Content-Length, Authorization
 * Bearer public, User-Agent opencode CLI, client cli, project global,
 * ascending msg id, plus the session id in two headers.
 * @param {Uint8Array} body exact bytes about to be sent (Content-Length must match)
 * @param {string} sessionID fresh per attempt (reuse ⇒ upstream 403)
 * @param {() => string} newMsgId ascending msg-id generator (injected for tests)
 */
export function zenHeaders(body, sessionID, newMsgId = () => require0()) {
  const headers = {
    'accept-encoding': 'identity',
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
    authorization: AUTH_VALUE,
    'user-agent': USER_AGENT,
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    'x-opencode-request': newMsgId(),
    'x-opencode-session': sessionID,
    'x-opencode-session-id': sessionID,
  };
  return headers;
}

function require0() {
  throw new Error('newMsgId is required');
}

/**
 * Port of zen.go normalizeUpstreamModel: strip an `opencodehub/` or
 * `opencodehub-` prefix; bare ids pass through.
 */
export function normalizeUpstreamModel(model) {
  const trimmed = (model ?? '').trim();
  if (trimmed.startsWith('opencodehub/')) return trimmed.slice('opencodehub/'.length);
  if (trimmed.startsWith('opencodehub-')) return trimmed.slice('opencodehub-'.length);
  return trimmed;
}

/**
 * Port of zen.go zenChatBody: rewrite a client chat body for upstream.
 * Whitelist-copy semantics: only model/stream/messages/tools/tool_choice/
 * temperature/max_tokens survive, which equals Go's copy-then-delete of
 * stream_options/response_format/user/seed/stop.
 * @param {object} clientBody already-OpenAI-shaped body from the host projection
 * @param {ToolMapper} mapper from upstreamToolList()
 * @param {string} upstreamModel normalized model id
 */
export function zenChatBody(clientBody, mapper, upstreamModel) {
  const body = {
    model: upstreamModel,
    stream: true,
    messages: upstreamMessages(clientBody.messages, mapper),
  };
  if (Array.isArray(clientBody.tools) && clientBody.tools.length > 0) {
    body.tools = clientBody.tools; // already renamed by upstreamToolList()
  }
  if (clientBody.tool_choice !== undefined) {
    body.tool_choice =
      typeof clientBody.tool_choice === 'object' && clientBody.tool_choice?.function?.name !== undefined
        ? { ...clientBody.tool_choice, function: { ...clientBody.tool_choice.function, name: mapper.upstreamOf(clientBody.tool_choice.function.name) } }
        : clientBody.tool_choice;
  }
  if (clientBody.temperature !== undefined) body.temperature = clientBody.temperature;
  if (clientBody.max_tokens !== undefined) body.max_tokens = clientBody.max_tokens;
  return body;
}

/**
 * Port of tools.go upstreamMessages: rewrite tool-call function names inside
 * history to upstream spellings. Client message shape here is the OpenAI wire
 * shape already projected by the host: {role, content?, tool_calls?, tool_call_id?}.
 * @param {Array} messages
 * @param {ToolMapper} mapper
 */
export function upstreamMessages(messages, mapper) {
  return (messages ?? []).map((message) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((call) => ({
        ...call,
        function: call?.function
          ? { ...call.function, name: mapper.upstreamOf(call.function?.name ?? '') }
          : call.function,
      })),
    };
  });
}

/**
 * Port of zen.go truncateBody: newlines → spaces, trim, cut at 400 with `...`.
 */
export function truncateBody(text) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 400) return oneLine;
  return `${oneLine.slice(0, 400)}...`;
}

/** Retryable upstream statuses (Go retryableStatus): 403, 429, >= 500. */
export function retryableStatus(status) {
  return status === 403 || status === 429 || status >= 500;
}
