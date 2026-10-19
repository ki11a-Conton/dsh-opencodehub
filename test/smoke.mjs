/**
 * Live smoke test — one real request through the adapter to OpenCode Zen.
 *   E:\node\node.exe test\smoke.mjs [model]
 * Uses the plugin default proxy (Clash 127.0.0.1:7897); set OPENCODEHUB_PROXY=direct
 * to bypass. Prints StreamChunks as they arrive.
 */
import { ZenAdapter } from '../lib/adapter.js';

const model = process.argv[2] ?? 'big-pickle';
const config = {
  proxy: process.env.OPENCODEHUB_PROXY ?? 'http://127.0.0.1:7897',
  baseUrl: 'https://opencode.ai/zen',
  maxAttempts: 3,
  headerTimeoutMs: 10_000,
  requestTimeoutMs: 600_000,
  dialTimeoutMs: 3_000,
  retryBackoffMs: 400,
  directoryTtlMs: 600_000,
};

const adapter = new ZenAdapter(config, console);

console.log(`--- listModels (${model} present?) ---`);
const models = await adapter.listModels('opencodehub');
console.log(`${models.length} models:`, models.map((m) => m.id).join(', '));

console.log(`--- streaming ${model} ---`);
const started = Date.now();
let textLen = 0;
for await (const chunk of adapter.stream({
  provider: 'opencodehub',
  model,
  messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
  signal: undefined,
})) {
  if (chunk.type === 'text-delta') {
    textLen += chunk.text.length;
    process.stdout.write(chunk.text);
  } else if (chunk.type === 'block-start') {
    console.log(`[block-start ${chunk.index} ${chunk.blockType}]`);
  } else if (chunk.type === 'block-end') {
    console.log(`\n[block-end ${chunk.index} ${chunk.block.type} len=${chunk.block.text?.length ?? chunk.block.arguments?.length ?? 0}]`);
  } else if (chunk.type === 'usage') {
    console.log(`[usage in=${chunk.usage.inputTokens} out=${chunk.usage.outputTokens}]`);
  } else if (chunk.type === 'finish') {
    console.log(`[finish ${JSON.stringify(chunk.reason)}]`);
  } else {
    console.log(`[${chunk.type}]`, JSON.stringify(chunk).slice(0, 120));
  }
}
console.log(`\n--- done in ${((Date.now() - started) / 1000).toFixed(1)}s, text ${textLen} chars ---`);
