/**
 * Static Zen free-tier catalog — port of models.go.
 */

/** All ten models share the Go constants: 256K context, 32K output. */
export const ZEN_CONTEXT_WINDOW = 262_144;
export const ZEN_MAX_OUTPUT = 32_768;

/**
 * Compiled-in free tier (Go zenFreeModels). Keep the Go display names.
 * @type {Array<{id: string, name: string}>}
 */
export const ZEN_FREE_MODELS = [
  { id: 'big-pickle', name: 'Big Pickle' },
  { id: 'cat-jam-free', name: 'Cat Jam (free)' },
  { id: 'mimo-v2.6-flash-free', name: 'MiMo v2.6 Flash (free)' },
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek v4.1 Flash (free)' },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning (free)' },
  { id: 'nemotron-3.5-super-vl-free', name: 'Nemotron 3.5 Super VL (free)' },
  { id: 'longcat-2.5-preview-free', name: 'LongCat 2.5 Preview (free)' },
  { id: 'space-bunny-free', name: 'Space Bunny (free)' },
  { id: 'beam-free', name: 'Beam (free)' },
  { id: 'glm-5.3-flash-free', name: 'GLM 5.3 Flash (free)' },
];

/**
 * Retired ids: claimed but no longer published (Go zenRetiredModels). Kept so
 * a stale client reference still resolves and so directory refresh never
 * re-publishes them.
 */
export const ZEN_RETIRED_MODELS = new Set([
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
  'step-5-preview-free',
  'jev-1.13-free',
]);

/** Port of models.go isFreeTierID. */
export function isFreeTierID(id) {
  return id === 'big-pickle' || String(id ?? '').endsWith('-free');
}

/** Port of models.go displayNameFor: title-case segments; "(free)" suffix. */
export function displayNameFor(id) {
  const base = id.endsWith('-free') ? id.slice(0, -'-free'.length) : id;
  const words = base
    .split(/[-_]/)
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1));
  const name = words.join(' ');
  return id.endsWith('-free') ? `${name} (free)` : name;
}

/** Model metadata shared by listModels / resolveModel (no reasoning efforts). */
export function modelMeta(id) {
  return {
    id,
    name: ZEN_FREE_MODELS.find((m) => m.id === id)?.name ?? displayNameFor(id),
    contextWindow: ZEN_CONTEXT_WINDOW,
    maxTokens: ZEN_MAX_OUTPUT,
  };
}
