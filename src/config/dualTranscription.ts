// Dual transcription sends one recording to two providers and has an LLM merge the
// two transcripts.
//
// The model each provider runs is fixed here rather than taken from the single
// provider selection in Settings: merging only makes sense between two comparable
// transcripts, and the single picker holds one provider's choice, which says nothing
// about the second. That is also why the settings UI has to describe these — a user
// looking at the single-provider picker while dual is on is reading a selection that
// does not apply.
export interface DualTranscriptionProvider {
  id: string;
  label: string;
  model: string;
  /** Settings store key holding this provider's BYOK key. Dual needs one per side. */
  apiKeyField: "groqApiKey" | "xaiApiKey" | "openaiApiKey";
}

// Order is the dropdown order and the slot defaults below, best first.
//
// xAI leads on measurement, not preference: it was the fastest transcriber tested (591ms
// median against 892ms for gpt-transcribe on the same audio) and it answered first in
// every race the wait budget decided. It is also first for a subtler reason — asked to
// merge two readings it cannot separate on the merits, the model picked version_a both
// times in an A/B with the labels swapped, so slot order is a real tie-break and the
// most accurate recogniser should hold the first slot.
export const DUAL_TRANSCRIPTION_PROVIDERS: DualTranscriptionProvider[] = [
  { id: "xai", label: "xAI", model: "grok-stt", apiKeyField: "xaiApiKey" },
  { id: "openai", label: "OpenAI", model: "gpt-transcribe", apiKeyField: "openaiApiKey" },
  { id: "groq", label: "Groq", model: "whisper-large-v3-turbo", apiKeyField: "groqApiKey" },
];

/**
 * The slots a multi-provider dictation can fill. Three because that is what the
 * providers above support today; the fan-out itself is written for any number.
 *
 * Persisted key names keep the "dual" prefix on purpose: renaming them would orphan
 * every existing user's provider and model choices, and a settings migration is a worse
 * trade than a legacy name behind a renamed UI.
 */
export const MULTI_TRANSCRIPTION_SLOTS = [
  { slot: "A", providerKey: "dualTranscriptionProviderA", modelKey: "dualTranscriptionModelA" },
  { slot: "B", providerKey: "dualTranscriptionProviderB", modelKey: "dualTranscriptionModelB" },
  { slot: "C", providerKey: "dualTranscriptionProviderC", modelKey: "dualTranscriptionModelC" },
] as const;

/** A slot set to this runs nothing, which is how a two-provider setup is expressed. */
export const NO_PROVIDER = "none";

export const DUAL_TRANSCRIPTION_MODELS: Record<string, string> = Object.fromEntries(
  DUAL_TRANSCRIPTION_PROVIDERS.map((provider) => [provider.id, provider.model])
);

export const DUAL_TRANSCRIPTION_API_KEY_FIELDS: Record<string, string> = Object.fromEntries(
  DUAL_TRANSCRIPTION_PROVIDERS.map((provider) => [provider.id, provider.apiKeyField])
);

export const DEFAULT_DUAL_PROVIDER_A = "xai";
export const DEFAULT_DUAL_PROVIDER_B = "openai";
export const DEFAULT_DUAL_PROVIDER_C = "groq";

/** Slot defaults, keyed the way the fan-out reads them. */
export const DEFAULT_SLOT_PROVIDERS: Record<string, string> = {
  A: DEFAULT_DUAL_PROVIDER_A,
  B: DEFAULT_DUAL_PROVIDER_B,
  C: DEFAULT_DUAL_PROVIDER_C,
};

// Who merges the two transcripts when they disagree. Reconciling is a judgement call
// about what was actually said, so it wants a strong model, and it sits in the paste
// path, so it wants a fast and predictable one.
//
// Benchmarked over the real reconcile prompt on 2026-08-03, three runs each: this
// model returned in 600-660ms, the tightest spread of everything measured, against
// 521-830ms for Groq's gpt-oss-120b and 5.2-6.4s for grok-4.5, whose reasoning tokens
// make it unusable here even at reasoning_effort low. It is also the non-reasoning
// variant, so it has no thinking budget to blow through on a hard disagreement.
//
// Same two-defaults hazard as the timeout below: the store seeds these and
// audioManager falls back to them.
export const DEFAULT_RECONCILE_PROVIDER = "xai";
export const DEFAULT_RECONCILE_MODEL = "grok-4.20-0309-non-reasoning";

// Tie-break order for the merge, best first, passed to the reconcile prompt as a
// preference of last resort. Based on what these providers actually produce here: xAI
// answered first in every race the wait budget decided, and its transcripts have needed
// the fewest corrections. It only settles disagreements the prompt cannot judge on the
// merits — a correctly spelled name or a more plausible reading wins regardless of side.
export const TRANSCRIPTION_QUALITY_ORDER = ["xai", "openai", "groq"];

// Providers offered for reconciliation. Limited to the ones whose model list the
// static registry knows, so the model picker beside it can be a closed choice
// rather than free text — tinfoil and corti fetch theirs at runtime.
export const RECONCILE_PROVIDER_IDS = ["groq", "xai", "openai", "anthropic", "gemini"];

// How long the second provider gets *after* the first has answered. Past this the
// slow side is abandoned and the result already in hand is used, so this is exactly
// the tail latency dual mode adds over a single provider — not a deadline on the
// pair, which would drop both when the network is merely slow.
//
// Lives here because two defaults have to agree: the settings store seeds
// dualTranscriptionSecondTimeoutMs from it, and audioManager falls back to it when
// the setting is absent. When they disagreed, the store's value silently won.
export const DEFAULT_DUAL_SECOND_TIMEOUT_MS = 1000;

export function getDualTranscriptionProvider(id: string): DualTranscriptionProvider | undefined {
  return DUAL_TRANSCRIPTION_PROVIDERS.find((provider) => provider.id === id);
}

/**
 * The model a dual side actually runs: the user's choice when they made one, and
 * otherwise the provider's default from the table above.
 *
 * Stored empty rather than pre-filled so a provider change does not leave the other
 * provider's model id behind, and so changing a default here reaches everyone who
 * never picked a model.
 */
export function resolveDualTranscriptionModel(providerId: string, storedModel?: string): string {
  const chosen = storedModel?.trim();
  if (chosen) return chosen;
  return getDualTranscriptionProvider(providerId)?.model ?? "";
}
