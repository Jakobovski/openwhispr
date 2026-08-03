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

export const DUAL_TRANSCRIPTION_PROVIDERS: DualTranscriptionProvider[] = [
  { id: "groq", label: "Groq", model: "whisper-large-v3-turbo", apiKeyField: "groqApiKey" },
  { id: "xai", label: "xAI", model: "grok-stt", apiKeyField: "xaiApiKey" },
  { id: "openai", label: "OpenAI", model: "gpt-4o-mini-transcribe", apiKeyField: "openaiApiKey" },
];

export const DUAL_TRANSCRIPTION_MODELS: Record<string, string> = Object.fromEntries(
  DUAL_TRANSCRIPTION_PROVIDERS.map((provider) => [provider.id, provider.model])
);

export const DUAL_TRANSCRIPTION_API_KEY_FIELDS: Record<string, string> = Object.fromEntries(
  DUAL_TRANSCRIPTION_PROVIDERS.map((provider) => [provider.id, provider.apiKeyField])
);

export const DEFAULT_DUAL_PROVIDER_A = "groq";
export const DEFAULT_DUAL_PROVIDER_B = "xai";

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
