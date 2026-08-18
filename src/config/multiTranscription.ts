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
// Benchmarked over the real reconcile prompt on 2026-08-18, 15 requests each, against
// the five candidates in RECONCILE_PROVIDER_IDS' openrouter entry plus the prior
// default: Inkling Small came back fastest and tightest — 321ms median, 291-779ms
// range, 14/15 correct — against 641ms/493-836ms/14-15 for xAI, the previous default.
// It has no thinking to suppress (supportsThinking: false in the registry), so there
// is no reasoning-token variance to begin with.
//
// Same two-defaults hazard as the timeout below: the store seeds these and
// audioManager falls back to them.
export const DEFAULT_RECONCILE_PROVIDER = "openrouter";
export const DEFAULT_RECONCILE_MODEL = "thinkingmachines/inkling-small";

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
//
// Trimmed deliberately to the three that survived benchmarking against the real
// reconcile prompt (2026-08-18, 15 real requests apiece), in priority order:
// Inkling Small (the default: fastest at 14/15), Haiku 4.5 (equally accurate,
// 685ms median), then xAI (the original default). Both of the first two are
// OpenRouter models — see its cloudProviders entry, ordered the same way — so
// "openrouter" sits ahead of "xai" here for the same reason. Gemini 3.6/3.7 Flash
// and Muse Glimmer were tested and cut for no measured reason to prefer them over
// these three: at best they tied on accuracy while running slower.
//
// nvidia/nemotron-3.5-lightning was tested separately and is not here at all: after
// a routing bug was found and fixed (see openrouterRouting.ts), it became the
// fastest of everything tried, but two content failures reproduced across two
// clean benchmark runs — it drops the frequency-bias rule with reasoning fully
// off, and once returned a different test case's answer outright.
export const RECONCILE_PROVIDER_IDS = ["openrouter", "xai"];

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

// The wait above is a floor, not the whole budget: it is what a lane gets regardless of
// how much audio there was. A longer dictation is more work for every provider, and the
// spread between the fastest and the slowest grows with it, so a fixed budget drops slow
// lanes on long recordings while being more than generous on short ones.
//
// The dynamic part is a percentage of the recording's own length, added to the floor.
// 5% by default: a 10-second dictation waits 1s + 0.5s, a minute waits 1s + 3s. The cost
// is only paid when a lane is actually late — the budget starts at the first success and
// ends the moment the rest answer — and the user has already waited the length of the
// recording itself by then, so the proportion is the honest unit.
//
// Set to 0 for the old fixed behaviour.
export const DEFAULT_MULTI_SECOND_TIMEOUT_PERCENT = 5;

// Offered in Settings. 0 means "flat only". 7.5 sits between the 5 default and 10 for
// someone who wants a bit more scaling without jumping straight to double.
export const MULTI_SECOND_TIMEOUT_PERCENT_CHOICES = [0, 5, 7.5, 10, 20, 30, 50];

// The percentage part has no ceiling of its own, so a long enough recording turns a
// generous-looking percentage into a genuinely long wait: at 50%, five minutes of audio
// is a 150-second budget. This is the safety valve — a hard cap on the *total* (floor
// plus percentage), so a percentage choice is never a blank check.
//
// 2.5s by default. Worth knowing how this interacts with the defaults above: at 1s flat
// + 5%, the percentage stops adding anything once a dictation passes ~30 seconds
// (1000 + 0.05 * 30000 = 2500) — the cap binds before the scaling does. Raise it, or
// raise the percentage, if that trade-off isn't what's wanted; both are independent
// settings.
export const DEFAULT_MULTI_SECOND_MAX_WAIT_MS = 2500;

// Offered in Settings. 0 means "no cap" — the percentage is free to grow unbounded.
export const MULTI_SECOND_MAX_WAIT_CHOICES_MS = [1500, 2000, 2500, 5000, 10000, 15000, 0];

/**
 * The wait a slow lane actually gets: the flat floor plus a share of the recording,
 * capped at a maximum.
 *
 * Every argument is treated as untrusted, because three of them are stored settings and
 * the fourth is a measured duration that is null whenever the recorder could not report
 * one. Anything unusable falls back to its own default — a budget that silently became 0
 * would drop every slow lane instead, and a max that silently became 0 would look
 * identical to "no cap" and remove the safety valve this exists to be.
 */
export function resolveMultiSecondWaitMs(
  flatMs: number | undefined,
  percent: number | undefined,
  recordingSeconds: number | null | undefined,
  maxMs?: number
): number {
  const flat = Number.isFinite(flatMs) && (flatMs as number) >= 0
    ? (flatMs as number)
    : DEFAULT_MULTI_SECOND_TIMEOUT_MS;
  const share =
    Number.isFinite(percent) && (percent as number) >= 0
      ? (percent as number)
      : DEFAULT_MULTI_SECOND_TIMEOUT_PERCENT;
  const seconds =
    Number.isFinite(recordingSeconds) && (recordingSeconds as number) > 0
      ? (recordingSeconds as number)
      : 0;
  const raw = Math.round(flat + (share / 100) * seconds * 1000);

  // maxMs is the one argument where 0 is a real, intentional value ("no cap") rather
  // than a stand-in for "not configured" — an explicit undefined is what means unset
  // here, the same distinction percent already draws for its own 0.
  const max = maxMs === undefined || !Number.isFinite(maxMs) || (maxMs as number) < 0
    ? DEFAULT_MULTI_SECOND_MAX_WAIT_MS
    : (maxMs as number);
  if (max === 0) return raw;
  return Math.min(raw, max);
}

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

// The wait choices offered for both budgets above. One list because they are the same
// kind of decision measured in the same units, and because the two panels that offer
// them — the lanes in Speech-to-Text, the merge in Cleanup — would otherwise each carry
// their own copy and drift.
export const MULTI_TIMEOUT_CHOICES_MS = [500, 750, 1000, 1500, 2000, 3000];

/**
 * A wait in seconds, for a label.
 *
 * toFixed(1) would render 750 ms as "0.8s". Trailing zeros are trimmed instead, so the
 * list reads 0.5 / 0.75 / 1 / 1.5 and every option says exactly what it is.
 */
export function formatTimeoutSeconds(ms: number): string {
  return String(Number((ms / 1000).toFixed(2)));
}

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
