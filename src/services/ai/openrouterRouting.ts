/**
 * OpenRouter provider-routing preferences for every chat completion this app sends
 * through it. One factory rather than a per-model setting: OpenRouter can route the
 * same model id across several backend providers with very different speed and
 * reliability — confirmed live for nvidia/nemotron-3.5-lightning, served by three
 * backends whose p90 latency ranged from 633ms to 22 seconds — and a new model added
 * to the registry gets this automatically rather than needing its own routing config.
 *
 * Fields per OpenRouter's provider-selection docs: `sort: "throughput"` is the modern
 * equivalent of the old `:nitro` model suffix. `preferred_max_latency` and
 * `preferred_min_throughput` take a percentile object (e.g. `{ p90: 1 }`) rather than
 * a bare number, and are documented as *soft* preferences — endpoints that miss the
 * threshold are deprioritised, not excluded, so a slow backend can still be used if
 * nothing else is available.
 */

// Seconds, per OpenRouter's units — not milliseconds.
export const OPENROUTER_MAX_LATENCY_P90_SECONDS = 1;
export const OPENROUTER_MIN_THROUGHPUT_P90_TPS = 80;

/**
 * Models routed to one named backend instead of by the preferences above.
 *
 * The soft preferences are the right default precisely because they need no
 * per-model upkeep, but they are *soft*: a model served by many backends of wildly
 * different speed can still be handed to a slow one. `only` is a hard restriction,
 * so it is worth spending an entry here when one backend is the entire reason the
 * model is on offer at all.
 *
 * openai/gpt-oss-120b is served by 20 backends. Cerebras is the fast one, measured
 * 2026-08-19 over the production request shape (8 samples, 1s apart): 189ms median,
 * 154-286ms, against 595ms median / 540-1097ms for the Claude Haiku 4.5 it replaces
 * as a merge default. Unpinned throughput sorting happened to pick Cerebras in all 8
 * samples too (224ms median), so this pin is about removing the other 19 as a
 * possibility rather than about correcting today's routing.
 *
 * Provider slugs are lowercase per OpenRouter's provider-selection docs.
 */
const PINNED_PROVIDERS: Record<string, string[]> = {
  "openai/gpt-oss-120b": ["cerebras"],
};

/**
 * Which model ids carry a pin. Exported so a test can check the reverse direction —
 * that every pinned id is one the registry still offers — which cannot be derived by
 * probing the factory with registry ids: a pin for a model the registry *doesn't*
 * have would never be probed, and the check would silently pass.
 */
export const PINNED_PROVIDER_MODEL_IDS = Object.keys(PINNED_PROVIDERS);

/**
 * Routing preferences for one OpenRouter call.
 *
 * Takes the model id so a pin can be looked up here rather than at the call site:
 * openai.ts stays model-agnostic, and a model added to the registry still needs no
 * routing config of its own to get the defaults.
 */
export function buildOpenRouterProviderRouting(model?: string): Record<string, unknown> {
  const pinned = model ? PINNED_PROVIDERS[model] : undefined;
  if (pinned) {
    // No sort or soft preferences alongside `only`: with a single permitted backend
    // there is nothing left to sort or deprioritise, and listing thresholds a pinned
    // backend might miss reads as though they could still route around it.
    return { only: pinned };
  }
  return {
    sort: "throughput",
    preferred_max_latency: { p90: OPENROUTER_MAX_LATENCY_P90_SECONDS },
    preferred_min_throughput: { p90: OPENROUTER_MIN_THROUGHPUT_P90_TPS },
  };
}

// The exact wording of the rejection some models return for a hard reasoning disable.
// Matched as a substring, not the whole message, since OpenRouter's error also nests
// per-provider detail that varies by model.
const REASONING_MANDATORY_ERROR = "Reasoning is mandatory";

export function isReasoningMandatoryError(message: string | null | undefined): boolean {
  return !!message && message.includes(REASONING_MANDATORY_ERROR);
}

// The softer reasoning request to retry with when a hard disable is rejected. Verified
// live against every reasoning-mandatory model found so far (Gemini 3.6/3.7 Flash,
// Meta's Muse Glimmer): all three accept `effort: "minimal"` where they reject
// `{ enabled: false }` outright.
export function fallbackReasoningRequest(): Record<string, unknown> {
  return { effort: "minimal" };
}
