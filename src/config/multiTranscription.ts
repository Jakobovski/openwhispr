// Multi transcription sends one recording to several providers at once and has an LLM
// merge what comes back.
//
// The model each provider runs is fixed here rather than taken from the single-provider
// selection in Settings: merging only makes sense between comparable transcripts, and
// that picker holds one provider's choice, which says nothing about the others. It is
// also why the settings UI has to describe these — someone reading the single-provider
// picker while multi is on is reading a selection that does not apply.
//
// The persisted setting keys below still say "dual". They are the names already in every
// user's localStorage, and renaming them would orphan their provider and model choices
// for a cosmetic gain; the code around them says what it means instead.
import modelRegistryData from "../models/modelRegistryData.json" with { type: "json" };

export interface MultiTranscriptionProvider {
  id: string;
  label: string;
  model: string;
  /** Settings store key holding this provider's BYOK key. Dual needs one per side. */
  apiKeyField:
    "groqApiKey" | "xaiApiKey" | "openaiApiKey" | "openrouterApiKey" | "azureSpeechApiKey";
}

// Order is the dropdown order and the slot defaults below, best first.
//
// xAI leads on measurement, not preference: it was the fastest transcriber tested (591ms
// median against 892ms for gpt-transcribe on the same audio) and it answered first in
// every race the wait budget decided. It is also first for a subtler reason — asked to
// merge two readings it cannot separate on the merits, the model picked version_a both
// times in an A/B with the labels swapped, so slot order is a real tie-break and the
// most accurate recogniser should hold the first slot.
export const MULTI_TRANSCRIPTION_PROVIDERS: MultiTranscriptionProvider[] = [
  { id: "xai", label: "xAI", model: "grok-stt", apiKeyField: "xaiApiKey" },
  { id: "openai", label: "OpenAI", model: "gpt-transcribe", apiKeyField: "openaiApiKey" },
  { id: "groq", label: "Groq", model: "whisper-large-v3", apiKeyField: "groqApiKey" },
  // Appended, not inserted. Order is the dropdown order *and* the substitution order
  // used when a stored slot collides with a default, so putting a new provider
  // anywhere but the end would silently change which lane fills a collision. It holds
  // slot C by default even so — see DEFAULT_MULTI_PROVIDER_C — because which provider a
  // slot defaults to is chosen there, independently of position in this list.
  {
    id: "openrouter",
    label: "OpenRouter",
    model: "microsoft/mai-transcribe-1.5",
    apiKeyField: "openrouterApiKey",
  },
  // The same model as the OpenRouter lane above, reached directly. Worth being a
  // separate lane rather than a swap: only this route accepts a phrase list, so the
  // two produce measurably different transcripts from identical audio.
  {
    id: "azure-speech",
    label: "Azure Speech",
    model: "mai-transcribe-1.5",
    apiKeyField: "azureSpeechApiKey",
  },
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

export const MULTI_TRANSCRIPTION_MODELS: Record<string, string> = Object.fromEntries(
  MULTI_TRANSCRIPTION_PROVIDERS.map((provider) => [provider.id, provider.model])
);

export const MULTI_TRANSCRIPTION_API_KEY_FIELDS: Record<string, string> = Object.fromEntries(
  MULTI_TRANSCRIPTION_PROVIDERS.map((provider) => [provider.id, provider.apiKeyField])
);

export const DEFAULT_MULTI_PROVIDER_A = "xai";
export const DEFAULT_MULTI_PROVIDER_B = "openai";
// Slot C is Azure's MAI-Transcribe. Same model as the OpenRouter lane, reached
// directly — which is the only route that accepts a phrase list, so this lane is the
// one that gets the speaker's own vocabulary before it listens. OpenRouter and Groq
// stay selectable.
export const DEFAULT_MULTI_PROVIDER_C = "azure-speech";

/**
 * Slot defaults, keyed the way the fan-out reads them.
 *
 * Zipped against MULTI_TRANSCRIPTION_SLOTS rather than written out as A/B/C, so adding
 * a slot cannot leave it with no default — it would previously have resolved to nothing
 * and the lane would silently never run. A slot beyond the defaults above gets
 * NO_PROVIDER, which is the honest answer: nobody has said what should fill it.
 */
const DEFAULT_PROVIDER_ORDER = [
  DEFAULT_MULTI_PROVIDER_A,
  DEFAULT_MULTI_PROVIDER_B,
  DEFAULT_MULTI_PROVIDER_C,
];

export const DEFAULT_SLOT_PROVIDERS: Record<string, string> = Object.fromEntries(
  MULTI_TRANSCRIPTION_SLOTS.map(({ slot }, index) => [
    slot,
    DEFAULT_PROVIDER_ORDER[index] ?? NO_PROVIDER,
  ])
);

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

// Tie-break order for the merge, best first. Azure's MAI-Transcribe leads because it is
// the only lane that can be biased *before* recognition: the phrase list carries the
// custom dictionary and the terms on screen, so on exactly the words a tie tends to be
// about — names, products, identifiers — it has information the others do not. xAI
// follows on measurement: it answered first in every race the wait budget decided, and
// its transcripts have needed the fewest corrections.
//
// Documentation, not wiring: the rule itself is written into the reconcile prompt,
// because the merge is an LLM reading labelled versions rather than code picking a
// winner. It is also the *weakest* rule in that prompt, below both the merits
// (correct spelling, plausibility in context) and a majority — two recognisers
// agreeing on a word outrank one recogniser's track record, so this only settles a
// straight 1-1 split or a three-way disagreement.
export const TRANSCRIPTION_QUALITY_ORDER = ["azure-speech", "xai", "openai", "groq"];

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
//
// One second: enough headroom for a slower lane — a routed provider adds a hop over a
// direct one — to still be compared rather than dropped. The cost of being generous is
// paid only when a lane is actually late, since the budget starts at the first success
// and ends the moment the rest answer.
export const DEFAULT_MULTI_SECOND_TIMEOUT_MS = 1000;

// How long the merge itself gets before it is abandoned and the best single transcript
// is used instead.
//
// A separate budget from the one above, because it bounds a different wait: that one is
// "how long a usable answer waits for a second opinion", this is "how long a second
// opinion waits for the model that combines them". Both sit in the paste path after the
// user has stopped speaking, so both are felt directly, but they fail differently — a
// dropped lane costs a comparison, a dropped merge costs the merge.
//
// One second against a measured spread of 600-660ms for the default reconcile model
// over the real prompt. That is deliberately more headroom than the measurement needs:
// the spread was taken on one model and one prompt length, and a merge that is dropped
// costs the whole comparison — three transcripts collapse back to one — where waiting
// costs only the extra milliseconds. Dropping is still cheap in the sense that the
// fallback is a real transcript rather than an error.
export const DEFAULT_RECONCILE_TIMEOUT_MS = 1000;

export function getMultiTranscriptionProvider(id: string): MultiTranscriptionProvider | undefined {
  return MULTI_TRANSCRIPTION_PROVIDERS.find((provider) => provider.id === id);
}

/**
 * The lanes a multi-provider dictation will actually run, in slot order.
 *
 * Resolution has to be deduplicated, and not only for tidiness: a stored slot combined
 * with a *default* slot can name the same provider, which is how a defaults change once
 * had one install sending every dictation to OpenAI twice while xAI never ran at all. A
 * duplicate lane is never useful — same provider, same model, same answer — and it costs
 * a second call and evicts a genuine second opinion.
 *
 * A slot the user chose is never overridden: an explicit duplicate is dropped. A slot
 * still on its default is filled with the first provider no other slot is using, so a
 * default can be reordered without silently collapsing the pair.
 */
export function resolveMultiTranscriptionLanes(
  settings: Record<string, unknown>
): Array<{ slot: string; provider: string; model: string }> {
  const used = new Set<string>();
  const lanes: Array<{ slot: string; provider: string; model: string }> = [];

  for (const { slot, providerKey, modelKey } of MULTI_TRANSCRIPTION_SLOTS) {
    const stored = (settings[providerKey] as string) || "";
    let provider = stored || DEFAULT_SLOT_PROVIDERS[slot] || NO_PROVIDER;
    if (!provider || provider === NO_PROVIDER) continue;

    if (used.has(provider)) {
      if (stored) continue; // the user asked for this twice; run it once
      const substitute = MULTI_TRANSCRIPTION_PROVIDERS.find((entry) => !used.has(entry.id));
      if (!substitute) continue;
      provider = substitute.id;
    }

    used.add(provider);
    lanes.push({
      slot,
      provider,
      model: resolveMultiTranscriptionModel(provider, settings[modelKey] as string),
    });
  }
  return lanes;
}

/** provider id -> the transcription model ids that provider actually serves. */
const SERVED_TRANSCRIPTION_MODELS: Record<string, Set<string>> = Object.fromEntries(
  (
    (
      modelRegistryData as {
        transcriptionProviders?: Array<{ id: string; models?: Array<{ id: string }> }>;
      }
    ).transcriptionProviders ?? []
  ).map((provider) => [provider.id, new Set((provider.models ?? []).map((model) => model.id))])
);

export function resolveMultiTranscriptionModel(providerId: string, storedModel?: string): string {
  const fallback = getMultiTranscriptionProvider(providerId)?.model ?? "";
  const chosen = storedModel?.trim();
  if (!chosen) return fallback;

  // A stored model id outlives the provider that was selected when it was picked: older
  // builds did not clear it on a provider change, and a slot still on its default can be
  // substituted to a different provider. Sending one provider's model id to another's
  // endpoint fails every time, and the settings picker — a closed list of this provider's
  // models — would show a selection that is not in it. Trust the stored id only if this
  // provider serves it; a provider the registry does not describe keeps the stored value.
  const served = SERVED_TRANSCRIPTION_MODELS[providerId];
  if (served && !served.has(chosen)) return fallback;
  return chosen;
}
