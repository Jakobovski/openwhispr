// Substitutes a live model when the stored one no longer exists.
//
// A provider can retire a model under us. Groq shut down `qwen/qwen3-32b` on
// 2026-07-17, and every request carrying that id then 404s. For dictation cleanup
// that surfaces as the raw transcript being pasted with no hint that a model went
// away, which makes it nearly impossible to attribute: transcription still works,
// reconciliation still works, and only the last step quietly fails.
//
// Pure functions over the registry's provider list so they can be tested without
// the store.

// These providers fetch their model list at runtime, so the static registry has
// no opinion on whether a stored id is still valid. Leave them alone.
export const DYNAMIC_MODEL_PROVIDERS = new Set(["custom", "openrouter", "tinfoil"]);

/**
 * Index a registry provider list as providerId -> ordered model ids.
 *
 * @param {Array<{id: string, models?: Array<{id: string}>}>} cloudProviders
 * @returns {Map<string, string[]>}
 */
export function buildProviderModelIndex(cloudProviders) {
  return new Map(
    (cloudProviders || []).map((provider) => [
      provider.id,
      (provider.models || []).map((model) => model.id),
    ])
  );
}

/**
 * The model to actually use for a provider.
 *
 * Returns the stored model untouched unless the provider has a known static list
 * that does not contain it, in which case the provider's first model stands in —
 * the registry orders them best-first, so this is also the sensible default.
 *
 * @param {string} provider
 * @param {string} model
 * @param {Map<string, string[]>} index - from buildProviderModelIndex
 * @returns {string}
 */
export function resolveUsableModel(provider, model, index) {
  // An empty model means "not configured", which is a different state from
  // "configured with something dead" — inventing one here would silently enable
  // a scope the user never set up.
  if (!provider || !model) return model;
  if (DYNAMIC_MODEL_PROVIDERS.has(provider)) return model;

  const known = index?.get(provider);
  // Unknown provider: local, enterprise, LAN. Not ours to judge.
  if (!known || known.length === 0) return model;
  if (known.includes(model)) return model;

  return known[0];
}
