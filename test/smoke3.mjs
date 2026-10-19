/**
 * Live smoke #3 — egress fallback (0.1.2). Runs one request through a
 * deliberately dead local proxy port: attempt 1 must fail the dial, suspend
 * the proxy (5 min), and attempt 2 must dial direct and succeed.
 *   E:\node\node.exe test\smoke3.mjs [model]
 */
import { ZenAdapter } from '../lib/adapter.js';
import { proxyEgressBlocked, egressLabel, clearProxyBlock } from '../lib/http.js';

clearProxyBlock();
const model = process.argv[2] ?? 'big-pickle';
const config = {
  // Port 59999: nothing listens there (same simulation as the Go test).
  proxy: 'http://127.0.0.1:59999',
  baseUrl: 'https://opencode.ai/zen',
  maxAttempts: 3,
  headerTimeoutMs: 10_000,
  requestTimeoutMs: 600_000,
  dialTimeoutMs: 3_000,
  retryBackoffMs: 400,
  directoryTtlMs: 600_000,
};

const logs = [];
const logger = { info: () => {}, warn: (m) => logs.push(`[warn] ${m}`) };
const adapter = new ZenAdapter(config, logger);

console.log(`--- dead-proxy fallback, model ${model} ---`);
const started = Date.now();
let textLen = 0;
for await (const chunk of adapter.stream({
  provider: 'opencodehub',
  model,
  messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
})) {
  if (chunk.type === 'text-delta') {
    textLen += chunk.text.length;
    process.stdout.write(chunk.text);
  } else if (chunk.type === 'finish') console.log(`\n[finish ${JSON.stringify(chunk.reason)}]`);
}
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`--- done in ${seconds}s, text ${textLen} chars ---`);
console.log('logs:', logs);
console.log('egress now:', egressLabel(config.proxy));
if (!proxyEgressBlocked()) throw new Error('expected the proxy to stay suspended after the dial failure');
console.log('FALLBACK VERIFIED: dial failure suspended the proxy, next attempt dialed direct and succeeded.');
