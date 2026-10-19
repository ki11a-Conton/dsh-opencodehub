/**
 * dsh-opencodehub — OpenCode Zen free-tier adapter for DeepSeek Harness.
 *
 * Registers a dsh-llm adapter for the provider route `opencodehub`, speaking
 * the OpenCode Zen wire protocol (ported from CLIProxyAPI's opencodehub
 * plugin): ten exact gate headers, forced streaming, `read`/`bash` tool gate
 * with bidirectional renaming, retry with fresh session ids, proxy support.
 */
import { register } from './plugin.js';
import { Config } from './config.js';

export const name = 'dsh-opencodehub';
export const inject = ['llm'];

export { Config };

/**
 * @param {object} ctx cordis context with the injected `llm` service
 * @param {object} config resolved plugin config (Config defaults applied)
 */
export function apply(ctx, config = {}) {
  return register(ctx, config);
}
