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

export function buildOpenRouterProviderRouting(): Record<string, unknown> {
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
