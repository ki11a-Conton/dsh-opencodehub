/**
 * Offline tests: no network. Run with the runtime node:
 *   E:\node\node.exe test\unit.mjs
 * Verifies ocID shape, tool gate mapping, SSE parsing, message serialization,
 * zen body rewrite, and finish semantics against the Go-port specs.
 */
import assert from 'node:assert/strict';
import { ocID } from '../lib/oc-id.js';
import { REQUIRED_GATE_TOOLS, upstreamToolList, ToolMapper, DeltaToolFilter } from '../lib/tools.js';
import { zenHeaders, normalizeUpstreamModel, zenChatBody, truncateBody, retryableStatus, USER_AGENT } from '../lib/zen.js';
import { parseSseData } from '../lib/http.js';
import { serializeMessages, serializeBody, LlmError, CODE } from '../lib/adapter.js';
import { ZEN_FREE_MODELS, displayNameFor, isFreeTierID } from '../lib/models.js';

const BASE62 = /^[0-9A-Za-z]+$/;
const HEX_LOWER = /^[0-9a-f]+$/;

// ---------- ocID ----------
{
  const ses = ocID('ses', true);
  assert.equal(ses.length, 4 + 12 + 14);
  assert.ok(ses.startsWith('ses_'));
  assert.ok(HEX_LOWER.test(ses.slice(4, 16)), 'time part must be lowercase hex');
  assert.ok(BASE62.test(ses.slice(16)), 'random part must be base62');

  const msg = ocID('msg', false);
  assert.ok(msg.startsWith('msg_'));
  assert.ok(HEX_LOWER.test(msg.slice(4, 16)));
  assert.ok(BASE62.test(msg.slice(16)));

  // ascending msg ids differ; descending session ids differ
  const seen = new Set(Array.from({ length: 50 }, () => ocID('msg', false)));
  assert.equal(seen.size, 50);
}

// ---------- headers ----------
{
  const body = new TextEncoder().encode('{"a":1}');
  const sessionId = ocID('ses', true);
  const headers = zenHeaders(body, sessionId, () => ocID('msg', false));
  assert.equal(headers['accept-encoding'], 'identity');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['content-length'], String(body.byteLength));
  assert.equal(headers.authorization, 'Bearer public');
  assert.equal(headers['user-agent'], USER_AGENT);
  assert.equal(headers['x-opencode-client'], 'cli');
  assert.equal(headers['x-opencode-project'], 'global');
  assert.ok(headers['x-opencode-request'].startsWith('msg_'));
  assert.equal(headers['x-opencode-session'], sessionId);
  assert.equal(headers['x-opencode-session-id'], sessionId);
  assert.equal(Object.keys(headers).length, 10);
}

// ---------- normalizeUpstreamModel ----------
{
  assert.equal(normalizeUpstreamModel('opencodehub/big-pickle'), 'big-pickle');
  assert.equal(normalizeUpstreamModel('opencodehub-big-pickle'), 'big-pickle');
  assert.equal(normalizeUpstreamModel('big-pickle'), 'big-pickle');
  assert.equal(normalizeUpstreamModel('  beam-free  '), 'beam-free');
}

// ---------- tool gate mapping ----------
{
  const clientTools = [
    { type: 'function', function: { name: 'Read', description: 'read files', parameters: {} } },
    { type: 'function', function: { name: 'web_search', description: 'search', parameters: {} } },
  ];
  const { mapper, upstreamTools } = upstreamToolList(clientTools);
  const names = upstreamTools.map((t) => t.function.name).sort();
  assert.deepEqual(names, ['bash', 'read', 'web_search'], 'Read renamed to lowercase read; bash placeholder injected; no read placeholder');
  assert.ok(upstreamTools.some((t) => t.function.name === 'read' && t.function.description === 'read files'), 'declared Read renamed outbound with client description');
  assert.ok(upstreamTools.some((t) => t.function.name === 'bash' && /NOT available/.test(t.function.description)), 'bash placeholder injected');

  // rename back on the response path
  assert.equal(mapper.clientOf('read'), 'Read');
  assert.equal(mapper.upstreamOf('Read'), 'read');
  assert.equal(mapper.upstreamOf('web_search'), 'web_search');

  // declared gate tools are not injected
  const declared = upstreamToolList([
    { type: 'function', function: { name: 'read', description: 'x', parameters: {} } },
    { type: 'function', function: { name: 'BASH', description: 'y', parameters: {} } },
  ]);
  assert.equal(declared.upstreamTools.length, 2);
  assert.ok(declared.mapper.isDeclared('bash'));

  // first declaration wins
  const m2 = new ToolMapper();
  m2.declare('Read');
  m2.declare('read');
  assert.equal(m2.upstreamOf('Read'), 'read');
  assert.equal(m2.clientOf('read'), 'Read');
}

// ---------- delta filter ----------
{
  const mapper = new ToolMapper();
  mapper.declare('Edit'); // declared non-gate tool
  const filter = new DeltaToolFilter(mapper);
  const delta1 = { tool_calls: [
    { index: 0, id: 'c1', function: { name: 'read', arguments: '' } },
    { index: 1, id: 'c2', function: { name: 'bash', arguments: '{}' } },
    { index: 2, id: 'c3', function: { name: 'Edit', arguments: '{"x"' } },
  ] };
  filter.filter(delta1);
  assert.equal(delta1.tool_calls.length, 1);
  assert.equal(delta1.tool_calls[0].function.name, 'Edit');

  const delta2 = { tool_calls: [{ index: 1, function: { arguments: '}}' } }] };
  filter.filter(delta2);
  assert.equal(delta2.tool_calls, undefined, 'dropped placeholder continuation removed');

  const delta3 = { tool_calls: [{ index: 2, function: { arguments: '"y"}' } }] };
  filter.filter(delta3);
  assert.equal(delta3.tool_calls[0].function.arguments, '"y"}');

  // tool_calls finish with zero visible calls collapses to stop (adapter logic)
  assert.equal(filter.sawCall, true);
  const allDropped = new DeltaToolFilter(new ToolMapper());
  const d = { tool_calls: [{ index: 0, id: 'z', function: { name: 'read', arguments: '' } }] };
  allDropped.filter(d);
  assert.equal(allDropped.sawCall, false);
}

// ---------- SSE parsing ----------
{
  async function* streamOf(lines) {
    for (const line of lines) yield new TextEncoder().encode(line);
  }
  const payloads = [];
  for await (const p of parseSseData(streamOf([
    ': comment\n\n',
    'event: ping\n',
    'data: {"a":1}\n\n',
    'data:{"b":2}\n',
    'data: [DONE]\n',
    'data: {"c":3}\n\n',
  ]))) payloads.push(p);
  assert.deepEqual(payloads, ['{"a":1}', '{"b":2}', '{"c":3}']);
}

// ---------- message serialization ----------
{
  const wire = serializeMessages([
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'developer', content: [{ type: 'tool-addition', name: 'x' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [
      { type: 'text', text: 'let me check' },
      { type: 'tool-call', id: 'call_1', name: 'Read', arguments: '{"p":1}' },
    ] },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'file body' }] },
  ]);
  assert.equal(wire.length, 4, 'developer dropped');
  assert.deepEqual(wire[0], { role: 'system', content: 'sys' });
  assert.equal(wire[2].tool_calls[0].function.name, 'Read');
  assert.equal(wire[2].content, 'let me check');
  assert.deepEqual(wire[3], { role: 'tool', tool_call_id: 'call_1', content: 'file body' });

  const body = serializeBody({ model: 'opencodehub/big-pickle', messages: wire, tools: [
    { name: 'Read', description: 'd', parameters: {} },
  ], maxTokens: 100 });
  assert.equal(body.model, 'opencodehub/big-pickle');
  assert.equal(body.max_tokens, 100);
  assert.equal(body.tools[0].function.name, 'Read');
}

// ---------- zen body rewrite ----------
{
  const { mapper, upstreamTools } = upstreamToolList([{ type: 'function', function: { name: 'Read', parameters: {} } }]);
  const rewritten = zenChatBody({
    model: 'big-pickle',
    stream: false,
    messages: [{ role: 'user', content: 'go' }],
    tools: upstreamTools,
    temperature: 0.5,
    stop: ['END'],
    stream_options: { include_usage: true },
    response_format: { type: 'json_object' },
    user: 'u',
    seed: 1,
  }, mapper, 'big-pickle');
  assert.equal(rewritten.stream, true, 'stream forced');
  assert.equal(rewritten.temperature, 0.5);
  assert.equal(rewritten.stop, undefined, 'stop stripped');
  assert.equal(rewritten.stream_options, undefined);
  assert.equal(rewritten.response_format, undefined);
  assert.equal(rewritten.user, undefined);
  assert.equal(rewritten.seed, undefined);
  assert.equal(rewritten.tools.length, 2, 'Read→read renamed + bash placeholder injected');
}

// ---------- plugin wiring (mock ctx.llm) ----------
{
  const { apply } = await import('../lib/index.js');
  const registered = [];
  const ctx = {
    logger: console,
    llm: {
      registerAdapter(routes, adapter) {
        registered.push({ routes, adapter });
        return { replace() {} };
      },
    },
  };
  apply(ctx, {});
  assert.equal(registered.length, 1, 'exactly one adapter registration');
  assert.deepEqual(registered[0].routes, ['opencodehub']);
  const adapter = registered[0].adapter;
  assert.deepEqual(adapter.providerInfo('opencodehub'), { id: 'opencodehub', name: 'OpenCode Zen (free tier)' });
  const models = await adapter.listModels('opencodehub');
  assert.ok(models.length >= 10, 'static catalog always present');
  assert.ok(models.every((m) => m.provider === 'opencodehub' && m.id && m.name));
  const call = await adapter.prepareCall('opencodehub', 'big-pickle', undefined);
  assert.equal(call.model.id, 'big-pickle');
  assert.equal(typeof call.stream, 'function');
}

// ---------- egress fallback (0.1.2, ports of the four Go tests) ----------
{
  const { markProxyBlocked, proxyEgressBlocked, clearProxyBlock, dialsThroughProxy, isFreeTierBody, egressLabel, FREE_TIER_COOLDOWN_MS, PROXY_DOWN_COOLDOWN_MS } = await import('../lib/http.js');

  // TestFreeTierBodyDetection: both upstream variants recognized; unrelated 403 not.
  const fromWithin = `{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode."}}`;
  const fromAddress = `{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address."}}`;
  const other = `{"error":{"type":"AuthError","message":"invalid key"}}`;
  assert.ok(isFreeTierBody(fromWithin), 'identity variant recognized');
  assert.ok(isFreeTierBody(fromAddress), 'address variant recognized');
  assert.ok(!isFreeTierBody(other), 'unrelated error not mistaken for a free tier block');

  // TestFreeTierBlockSuspendsTheProxy
  clearProxyBlock();
  assert.ok(dialsThroughProxy('http://127.0.0.1:7897'), 'proxy in use before any block');
  markProxyBlocked(FREE_TIER_COOLDOWN_MS, 'test block');
  assert.ok(!dialsThroughProxy('http://127.0.0.1:7897'), 'proxy suspended after free tier block');
  assert.equal(egressLabel('http://127.0.0.1:7897'), 'direct (proxy suspended: the free tier refused the proxy address)');

  // TestProxyBlockExpires
  markProxyBlocked(15, 'test block');
  assert.ok(proxyEgressBlocked(), 'block applied');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(!proxyEgressBlocked(), 'block expired');
  assert.ok(dialsThroughProxy('http://127.0.0.1:7897'), 'proxy came back after expiry');

  // TestDirectModeIsUnaffectedByBlocks
  clearProxyBlock();
  markProxyBlocked(FREE_TIER_COOLDOWN_MS, 'test block');
  assert.ok(!dialsThroughProxy('direct'), 'direct mode never uses a proxy');
  assert.equal(egressLabel(''), 'direct (no proxy, configured)', 'direct-configured label');
  clearProxyBlock();
  assert.equal(egressLabel('http://127.0.0.1:7897'), 'http://127.0.0.1:7897', 'healthy proxy label');

  // markProxyBlocked logs only on transition
  const logs = [];
  const logger = { warn: (m) => logs.push(m) };
  markProxyBlocked(60_000, 'first', logger);
  markProxyBlocked(60_000, 'second', logger); // still suspended → no second log
  assert.equal(logs.length, 1, 'transition-only logging');
  clearProxyBlock();
}

// ---------- truncate / retryable ----------
{
  assert.equal(truncateBody('a\n b\t  c'), 'a b c');
  assert.equal(truncateBody('x'.repeat(500)).length, 403);
  assert.ok(truncateBody('x'.repeat(500)).endsWith('...'));
  assert.ok(retryableStatus(403) && retryableStatus(429) && retryableStatus(500));
  assert.ok(!retryableStatus(400) && !retryableStatus(404) && !retryableStatus(410));
}

// ---------- LlmError shape (host normalizeLlmFailure contract) ----------
{
  const err = new LlmError('upstream http 429: slow down', CODE.RATE_LIMIT, { status: 429, requestId: 'req_1' });
  assert.equal(err instanceof Error, true);
  const desc = Object.getOwnPropertyDescriptor(err, 'code');
  assert.ok(desc && 'value' in desc, 'code must be own data property');
  const fd = Object.getOwnPropertyDescriptor(err, 'failure');
  assert.ok(fd && 'value' in fd, 'failure must be own data property');
  assert.deepEqual(fd.value, { message: 'upstream http 429: slow down', code: 'RATE_LIMIT', status: 429, requestId: 'req_1' });
  assert.equal(Object.isFrozen(fd.value), true);
}

// ---------- models ----------
{
  assert.equal(ZEN_FREE_MODELS.length, 10);
  assert.ok(isFreeTierID('big-pickle') && isFreeTierID('anything-free'));
  assert.ok(!isFreeTierID('gpt-4'));
  assert.equal(displayNameFor('my-new-model-free'), 'My New Model (free)', 'fallback title-cases segments');
  assert.equal(displayNameFor('big-pickle'), 'Big Pickle');
  assert.equal(ZEN_FREE_MODELS.find((m) => m.id === 'deepseek-v4.1-flash-free').name, 'DeepSeek v4.1 Flash (free)', 'static catalog keeps Go display names; fallback title-casing need not match exactly');
}

console.log('ALL OFFLINE TESTS PASSED');
