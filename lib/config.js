/**
 * dsh-opencodehub configuration schema.
 *
 * Schema follows the dsh-plugin-debugging convention: plain
 * `@deepseek-ai/schemastery` object with `.default()` on every field, so the
 * plugin works with zero configuration (the Go original also ran on defaults).
 */
import z from '@deepseek-ai/schemastery';

export const Config = z
  .object({
    /** Outbound proxy for every Zen request. `direct`/`none`/`off` disable proxying. */
    proxy: z.string().default('http://127.0.0.1:7897'),
    /** Extra base URL override for the Zen API (must end before `/chat/completions`). */
    baseUrl: z.string().default('https://opencode.ai/zen'),
    /** Sequential attempts per chat request before giving up (Go: zenMaxAttempts). */
    maxAttempts: z.number().default(3),
    /** Response-header timeout in ms (Go: zenHeaderTimeout = 10s). */
    headerTimeoutMs: z.number().default(10_000),
    /** Whole-request timeout in ms (Go: zenRequestTimeout = 600s). */
    requestTimeoutMs: z.number().default(600_000),
    /** Proxy dial timeout in ms (Go: proxyDialTimeout = 3s). */
    dialTimeoutMs: z.number().default(3_000),
    /** Backoff base between attempts in ms (Go: 400ms * attempt, linear). */
    retryBackoffMs: z.number().default(400),
    /** `/zen/v1/models` directory refresh TTL in ms (Go: 10min). */
    directoryTtlMs: z.number().default(600_000),
  })
  .default({});
