/**
 * Plugin wiring: resolve config, construct the adapter, register it on the
 * llm service. Registration is fiber-scoped (host disposes it with ctx).
 */
import { ZenAdapter } from './adapter.js';

export function register(ctx, config) {
  const logger = ctx.logger ?? console;
  const adapter = new ZenAdapter(config, logger);
  const registration = ctx.llm.registerAdapter(['opencodehub'], adapter);
  logger.info?.('dsh-opencodehub: zen adapter registered for provider "opencodehub" (%d static models)', 10);
  return registration;
}
