/**
 * Live smoke #2 — tool-call round: declare client tools Read + web_search,
 * ask the model to call Read, verify gate injection + rename-back works end
 * to end through translateAttempt.
 *   E:\node\node.exe test\smoke2.mjs [model]
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

const tools = [
  { name: 'Read', description: 'read files', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'web_search', description: 'search the web', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];

console.log(`--- tool-call streaming ${model} ---`);
const messages = [
  { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Use the Read tool to read the file package.json in the current directory. Call the tool now.' }] },
];
for await (const chunk of adapter.stream({
  provider: 'opencodehub',
  model,
  messages,
  tools,
  signal: undefined,
})) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.text);
  else if (chunk.type === 'reasoning-delta') process.stdout.write('.');
  else if (chunk.type === 'block-start') console.log(`[block-start ${chunk.index} ${chunk.blockType}]`);
  else if (chunk.type === 'block-end') {
    if (chunk.block.type === 'tool-call') {
      console.log(`[block-end tool-call] name=${chunk.block.name} (client spelling?) args=${chunk.block.arguments.slice(0, 120)}`);
    } else {
      console.log(`[block-end ${chunk.block.type} len=${chunk.block.text?.length ?? 0}]`);
    }
  } else if (chunk.type === 'finish') console.log(`[finish ${JSON.stringify(chunk.reason)}]`);
  else if (chunk.type === 'usage') console.log(`[usage in=${chunk.usage.inputTokens} out=${chunk.usage.outputTokens}]`);
}
