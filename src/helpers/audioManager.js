import ReasoningService from "../services/ReasoningService";
import { API_ENDPOINTS, buildApiUrl, normalizeBaseUrl } from "../config/constants";
import logger from "../utils/logger";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import {
  isSecureEndpoint,
  isAzureOpenAIEndpoint,
  buildAzureTranscriptionUrl,
} from "../utils/urlUtils";
import { withSessionRefresh } from "../lib/auth";
import { getBaseLanguageCode, getLanguageLabel } from "../utils/languageSupport";
import {
  createLocalSpeechGateState,
  getLocalSpeechGateDecision,
  recordLocalSpeechWindow,
} from "./localSpeechGate";
import { reacquireIfDead } from "./micTrackHealth";
import { ActiveMicRecoveryController } from "./activeMicRecovery";
import { followsSystemDefaultMic, reconcileSavedMicSelection } from "./micSelectionRecovery";
import { isStaleDeviceError } from "./staleMicDevice";
import { shouldSaveDiscardedRecording } from "./discardedRecording";
import { awaitLanesWithBudget, raceLanesForFirstSuccess } from "./multiTranscriptionRace";
import {
  getSettings,
  getEffectiveCleanupModel,
  getEffectiveReconcileModel,
  getEffectiveReconcileModelB,
  isCloudCleanupMode,
  isCloudDictationAgentMode,
  isCloudTranslationMode,
} from "../stores/settingsStore";
import { recordCleanupFailure } from "../stores/cleanupFailureStore";
import { isCleanupPermanentlyUnavailable } from "../utils/cleanupFailure";
import { transcriptsAgree, chooseFallbackTranscript } from "../utils/transcriptReconcile";
import { wordErrorRate } from "../utils/wordErrorRate";
import { PcmBatchRecorder } from "./pcmBatchRecorder";
import { concatFrames } from "../utils/pcmAudio";
import settingsDefaults from "../config/settingsDefaults.json";
import { buildReconcileRequest } from "./reconcileRequest";
import {
  MULTI_TRANSCRIPTION_MODELS,
  MULTI_TRANSCRIPTION_API_KEY_FIELDS,
  getMultiTranscriptionProvider,
  DEFAULT_MULTI_PROVIDER_A,
  DEFAULT_MULTI_PROVIDER_B,
  DEFAULT_MULTI_PROVIDER_C,
  resolveMultiTranscriptionLanes,
  resolveMultiSecondWaitMs,
  DEFAULT_RECONCILE_PROVIDER,
  DEFAULT_RECONCILE_PROVIDER_B,
  DEFAULT_RECONCILE_TIMEOUT_MS,
  resolveMultiTranscriptionModel,
  providerWantsStreaming,
} from "../config/multiTranscription";

import {
  getBatchTranscriptionModel,
  getTranscriptionProvider,
  isOnlineParakeetModel,
} from "../models/ModelRegistry";
import { shouldSkipTranscriptionApiKey } from "./transcriptionAuth";
import {
  isSelfHostedTranscription,
  resolveSelfHostedTranscriptionModel,
} from "./selfHostedTranscription";
import { resolveStreamingFallbackTarget } from "./transcriptionFallback";
import {
  executeTranslationChain,
  resolveTranslatedText,
  shouldRunTranslateStep,
} from "./translationChain";
import { detectAgentName } from "../config/agentDetection";
import {
  resolveDictationRouteKind,
  resolveDictationTranslationReachability,
} from "./dictationRouting";
import { resolveDictationAgentInference } from "./dictationAgentInference";
import { resolvePrompt } from "../config/prompts";
import { syncService } from "../services/SyncService.js";
import { evaluateFinishedRecording } from "./recordingValidation";
import { isEmptyRecording } from "./recordingGuard";
import { matchesDictionaryPrompt } from "../utils/dictionaryEchoFilter.js";
import { planSilenceTrim, applySilenceTrim, resolveSilenceTrimOptions } from "../utils/silenceTrim";
import { planAutoGain } from "../utils/autoGain";
import { normalizeDictationTerms } from "../utils/dictationTerms";
import {
  buildBatchRequest as buildGeminiBatchRequest,
  parseBatchResponse as parseGeminiBatchResponse,
  GEMINI_INTERACTIONS_PATH,
  GEMINI_VOCABULARY_LIMIT,
} from "../utils/geminiTranscribe";
import {
  buildAsyncTranscriptionRequest as buildSonioxAsyncRequest,
  parseAsyncTranscript as parseSonioxAsyncTranscript,
  asyncJobState as sonioxAsyncJobState,
  SONIOX_API_BASE,
  SONIOX_PATHS,
  SONIOX_TERM_LIMIT,
} from "../utils/sonioxTranscribe";
import { getDictionaryHintWords } from "../utils/snippets";

const REASONING_CACHE_TTL = 30000; // 30 seconds
const RECORDING_TIMESLICE_MS = 250; // flush chunks periodically so short recordings still carry audio frames. See #871.
// Failure detector only: fires when the worklet or audio graph is dead and never flushes.
const PREVIEW_FLUSH_WATCHDOG_MS = 1000;
const REALTIME_MODELS = new Set(["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]);
// How long a transcript will wait on the screen capture it was started with.
// Deliberately far below the sidecar's own budget: the capture has had the whole
// recording to finish, so anything still running here is stuck, and a stuck
// capture must cost the paste path milliseconds rather than seconds.
const SCREEN_CONTEXT_COLLECT_BUDGET_MS = 500;

// How many words of the speaker's vocabulary travel with a dictation — the custom
// dictionary plus the distinctive terms read from the screen, as one list.
//
// One limit rather than one per consumer. The same vocabulary goes to the recogniser
// that can be biased and to the model that merges the results, and a term that biased
// recognition but was invisible to the merge is the sort of inconsistency that makes a
// disagreement impossible to reason about.
const DICTATION_VOCABULARY_LIMIT = 200;

// Soniox async is a job queue, so it needs a poll interval and a ceiling. The ceiling is
// generous relative to the lane budget on purpose: the fan-out will already have dropped
// this lane long before it expires, so this only exists so a wedged job cannot leave a
// request in flight forever.
// Each provider's ceilings, in one table. xAI caps a term at 50 characters and the list
// at 100; Groq rejects a prompt over 896 characters; Gemini and Soniox take 1000 terms.
const PROVIDER_TERM_SHAPES = {
  xai: { limit: 100, maxTermLength: 50 },
  gemini: { limit: 1000 },
  soniox: { limit: 1000 },
  "azure-speech": { limit: 200 },
  groq: { limit: 1000, maxPromptChars: 890 },
  default: { limit: 200, maxPromptChars: 900 },
};

const XAI_KEYTERM_LIMIT = 100;
const XAI_KEYTERM_MAX_LENGTH = 50;
const SONIOX_ASYNC_POLL_MS = 300;
const SONIOX_ASYNC_TIMEOUT_MS = 30000;

// Providers whose transcription endpoint is OpenAI's: multipart POST to
// /audio/transcriptions with `file` and `model`, answering `{ text }`. xAI is absent
// on purpose — it goes through a main-process proxy and takes no model.
//
// OpenRouter is a router rather than a model host, so its `model` is a fully qualified
// slug like "microsoft/mai-transcribe-1.5". Its endpoint is documented as accepting
// OpenAI-style multipart, and does: verified against the live API.
// Azure wants a full locale ("en-US"), and rejects the bare language code every other
// provider here takes. Mapped rather than passed through, because "The specified locale
// is not supported" is what a bare "en" earns.
const AZURE_LOCALE_FALLBACKS = {
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  pt: "pt-BR",
  it: "it-IT",
  ru: "ru-RU",
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-CN",
  nl: "nl-NL",
  pl: "pl-PL",
  tr: "tr-TR",
  hi: "hi-IN",
  ar: "ar-EG",
};

function toAzureLocale(language) {
  const value = String(language || "").trim();
  if (!value) return undefined;
  // Already a full locale.
  if (value.includes("-")) return value;
  return AZURE_LOCALE_FALLBACKS[value.toLowerCase()];
}

const OPENAI_COMPATIBLE_TRANSCRIPTION = {
  openai: { apiKeyField: "openaiApiKey", base: API_ENDPOINTS.OPENAI_BASE },
  groq: { apiKeyField: "groqApiKey", base: API_ENDPOINTS.GROQ_BASE },
  openrouter: { apiKeyField: "openrouterApiKey", base: API_ENDPOINTS.OPENROUTER_BASE },
};

function dictationAgentReachable(settings) {
  return resolveDictationAgentInference(settings, { isCloudAgent: isCloudDictationAgentMode() })
    .reachable;
}

function translationChainReachable(settings) {
  const isSelfHostedTranslation =
    settings.translationMode === "self-hosted" && !!settings.translationRemoteUrl?.trim();
  return resolveDictationTranslationReachability({
    useDictationTranslation: settings.useDictationTranslation,
    translationTargetLanguage: settings.translationTargetLanguage,
    translationModel: settings.translationModel,
    isCloudTranslation: isCloudTranslationMode(),
    isSelfHostedTranslation,
  });
}

function resolveReasoningRoute(
  text,
  settings,
  agentName,
  voiceAgentRequested,
  translationRequested,
  alreadyCleaned = false
) {
  const cleanupReachable =
    !!settings.useCleanupModel && (!!settings.cleanupModel?.trim() || isCloudCleanupMode());
  const agent = resolveDictationAgentInference(settings, {
    isCloudAgent: isCloudDictationAgentMode(),
  });

  const isCloudTranslation = isCloudTranslationMode();
  const isSelfHostedTranslation =
    settings.translationMode === "self-hosted" && !!settings.translationRemoteUrl?.trim();
  const translationReachable = resolveDictationTranslationReachability({
    useDictationTranslation: settings.useDictationTranslation,
    translationTargetLanguage: settings.translationTargetLanguage,
    translationModel: settings.translationModel,
    isCloudTranslation,
    isSelfHostedTranslation,
  });

  const kind = resolveDictationRouteKind({
    cleanupReachable,
    agentReachable: agent.reachable,
    agentInvoked: !!agentName && detectAgentName(text, agentName),
    voiceAgentRequested,
    translationRequested,
    translationReachable,
    alreadyCleaned,
  });
  if (translationRequested && kind !== "translation") {
    logger.warn(
      "Translation requested but unreachable, falling back",
      {
        kind,
        useDictationTranslation: settings.useDictationTranslation,
        hasTarget: !!settings.translationTargetLanguage?.trim(),
      },
      "transcription"
    );
  }
  if (kind === "translation") {
    const provider = isCloudTranslation
      ? "openwhispr"
      : settings.translationProvider?.trim() || undefined;
    const isCustomTranslation = settings.translationMode === "providers" && provider === "custom";
    return {
      kind: "translation",
      model: settings.translationModel?.trim() || "",
      cleanupReachable,
      cleanupConfig: { disableThinking: settings.cleanupDisableThinking },
      config: {
        provider,
        language: settings.translationTargetLanguage,
        lanUrl: isSelfHostedTranslation ? settings.translationRemoteUrl : undefined,
        baseUrl: isCustomTranslation ? settings.translationCloudBaseUrl || undefined : undefined,
        customApiKey:
          isCustomTranslation || isSelfHostedTranslation
            ? settings.translationCustomApiKey || undefined
            : undefined,
        disableThinking: settings.translationDisableThinking,
        systemPrompt: resolvePrompt("translate", {
          agentName,
          targetLanguageLabel: getLanguageLabel(settings.translationTargetLanguage),
          customDictionary: getDictionaryHintWords(settings),
          uiLanguage: settings.uiLanguage,
        }),
      },
    };
  }
  if (kind === "agent") {
    return {
      kind: "agent",
      model: agent.model,
      config: {
        ...agent.config,
        systemPrompt: resolvePrompt("dictationAgent", {
          agentName,
          language: settings.preferredLanguage,
          customDictionary: getDictionaryHintWords(settings),
          uiLanguage: settings.uiLanguage,
        }),
      },
    };
  }
  if (kind === "cleanup") {
    return {
      kind: "cleanup",
      config: { disableThinking: settings.cleanupDisableThinking },
    };
  }
  return { kind: "skip" };
}

const PLACEHOLDER_KEYS = {
  openai: "your_openai_api_key_here",
  groq: "your_groq_api_key_here",
  xai: "your_xai_api_key_here",
  mistral: "your_mistral_api_key_here",
};

const isValidApiKey = (key, provider = "openai") => {
  if (!key || key.trim() === "") return false;
  const placeholder = PLACEHOLDER_KEYS[provider] || PLACEHOLDER_KEYS.openai;
  return key !== placeholder;
};

// Providers selectable for dual transcription, and the model each uses. Separate
// from getTranscriptionModel(), which resolves the single active provider's
// selected model and has no notion of a second provider running alongside it.
// Reconciling is a judgement call about what was actually said, so it gets a
// strong model. GPT-OSS 120B is served text-to-text over Groq's chat completions
// endpoint like any other model here.
//
// It is a reasoning model (supportsThinking in the registry), so it may spend
// thinking tokens before answering. Any <think> block is stripped from the reply
// by ReasoningService, but the tokens still cost latency in the paste path — if
// that proves too slow, llama-3.3-70b-versatile is the non-reasoning fallback.
// Dual mode requires an explicit opt-in, BYOK credentials, and a key for each
// selected provider — a half-configured pair would silently degrade to whichever
// side happened to work, which is worse than staying on the single-provider path.
// The provider id doing the transcribing right now, or null when it cannot be
// named. Deliberately derived from the mode plus the stored selection rather than
// from a list of known providers, so nothing here needs touching when one is added.
function resolveActiveTranscriptionProvider(settings) {
  if (!settings) return null;
  if (settings.useLocalWhisper)
    return (
      settings.localTranscriptionProvider ||
      settingsDefaults.storeDefaults.localTranscriptionProvider
    );
  if (settings.transcriptionMode === "openwhispr") return "openwhispr";
  if (settings.transcriptionMode === "self-hosted") return "lan";
  return settings.cloudTranscriptionProvider || null;
}

function isMultiTranscriptionEnabled(settings) {
  if (!settings?.multiTranscriptionEnabled) return false;
  if (settings.useLocalWhisper) return false;
  if (settings.cloudTranscriptionMode !== "byok") return false;
  // At least two lanes that actually have a key. One lane is the single-provider path with
  // extra machinery, and a lane without a key is a guaranteed failure rather than a second
  // opinion. Lanes come from the shared resolver, so duplicates are already collapsed.
  const withKeys = resolveMultiTranscriptionLanes(settings).filter((lane) => {
    const keyField = MULTI_TRANSCRIPTION_API_KEY_FIELDS[lane.provider];
    return keyField && settings[keyField];
  });
  return withKeys.length >= 2;
}

// Minimal 16-bit PCM WAV writer. The trimmed audio only exists as samples, and
// every provider here accepts WAV, so re-encoding to the original codec would be
// work for nothing. Larger in bytes than WebM, shorter in the duration that gets
// billed.
// Every provider here resamples to 16 kHz internally — Groq documents preprocessing to
// it, xAI warns that anything else costs a server-side resample — so sending 48 kHz is
// three times the bytes for identical transcripts. Measured across all three providers on
// 2026-08-04: 16 kHz produced byte-identical text and cut OpenAI's median from 2278ms to
// 1064ms.
const UPLOAD_SAMPLE_RATE = 16000;

/**
 * Resamples mono samples to UPLOAD_SAMPLE_RATE using the browser's own resampler, which
 * band-limits properly; decimating by hand would alias the speech it is meant to preserve.
 *
 * Returns the input untouched when it is already at or below the target — upsampling to
 * hit a number would add bytes and no information.
 */
async function resampleForUpload(samples, sampleRate) {
  if (!samples.length || sampleRate <= UPLOAD_SAMPLE_RATE) {
    return { samples, sampleRate };
  }
  const frames = Math.max(1, Math.round((samples.length * UPLOAD_SAMPLE_RATE) / sampleRate));
  const offline = new OfflineAudioContext(1, frames, UPLOAD_SAMPLE_RATE);
  const buffer = offline.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return { samples: rendered.getChannelData(0), sampleRate: UPLOAD_SAMPLE_RATE };
}

// `gain` is folded into the clamp below rather than applied in a pass of its own: this
// loop already touches and clamps every sample, so amplifying here costs one multiply
// and no second traversal or allocation. See autoGain.js for why that matters — a
// separate apply pass was measured at 5.5ms on a five-minute recording.
// Base64 for Gemini's interactions endpoint, which takes audio inline rather than as a
// reference to an uploaded file — one request instead of upload-then-transcribe.
//
// Chunked on purpose: String.fromCharCode(...bytes) over a whole recording exceeds the
// argument limit and throws, and a 30-second dictation is already about a megabyte.
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

function encodeWavPcm16(samples, sampleRate, gain = 1) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    // The clamp is what makes amplifying safe here: autoGain leaves headroom against a
    // robust peak, so the true maximum can sit above it by design and the loudest few
    // samples must saturate rather than wrap.
    const clamped = Math.max(-1, Math.min(1, samples[i] * gain));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

// Which STREAMING_PROVIDERS entry a transcription provider streams through. Separate
// from the table of *which* providers can stream (STREAMING_CAPABLE_PROVIDERS) because
// the names differ: the xai provider streams through the "xai" entry, gemini through
// "gemini-live".
const STREAMING_PROVIDER_BY_TRANSCRIPTION_PROVIDER = {
  xai: "xai",
  soniox: "soniox",
  gemini: "gemini-live",
};

const STREAMING_PROVIDERS = {
  deepgram: {
    warmup: (opts) => window.electronAPI.deepgramStreamingWarmup(opts),
    start: (opts) => window.electronAPI.deepgramStreamingStart(opts),
    send: (buf) => window.electronAPI.deepgramStreamingSend(buf),
    finalize: () => window.electronAPI.deepgramStreamingFinalize(),
    stop: () => window.electronAPI.deepgramStreamingStop(),
    status: () => window.electronAPI.deepgramStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onDeepgramPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onDeepgramFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onDeepgramError(cb),
    onSessionEnd: (cb) => window.electronAPI.onDeepgramSessionEnd(cb),
  },
  assemblyai: {
    warmup: (opts) => window.electronAPI.assemblyAiStreamingWarmup(opts),
    start: (opts) => window.electronAPI.assemblyAiStreamingStart(opts),
    send: (buf) => window.electronAPI.assemblyAiStreamingSend(buf),
    finalize: () => window.electronAPI.assemblyAiStreamingForceEndpoint(),
    stop: () => window.electronAPI.assemblyAiStreamingStop(),
    status: () => window.electronAPI.assemblyAiStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onAssemblyAiPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onAssemblyAiFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onAssemblyAiError(cb),
    onSessionEnd: (cb) => window.electronAPI.onAssemblyAiSessionEnd(cb),
  },
  "openai-realtime": {
    warmup: (opts) => window.electronAPI.dictationRealtimeWarmup(opts),
    start: (opts) => window.electronAPI.dictationRealtimeStart(opts),
    send: (buf) => window.electronAPI.dictationRealtimeSend(buf),
    stop: () => window.electronAPI.dictationRealtimeStop(),
    onPartial: (cb) => window.electronAPI.onDictationRealtimePartial(cb),
    onFinal: (cb) => window.electronAPI.onDictationRealtimeFinal(cb),
    onError: (cb) => window.electronAPI.onDictationRealtimeError(cb),
    onSessionEnd: (cb) => window.electronAPI.onDictationRealtimeSessionEnd(cb),
  },
  // No warmup for either: both authenticate in their opening message, so there is no
  // token to pre-fetch and no idle connection worth holding open.
  "gemini-live": {
    start: (opts) => window.electronAPI.geminiLiveStreamingStart(opts),
    send: (buf) => window.electronAPI.geminiLiveStreamingSend(buf),
    finalize: () => window.electronAPI.geminiLiveStreamingFinalize(),
    stop: () => window.electronAPI.geminiLiveStreamingStop(),
    status: () => window.electronAPI.geminiLiveStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onGeminiLivePartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onGeminiLiveFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onGeminiLiveError(cb),
    onSessionEnd: (cb) => window.electronAPI.onGeminiLiveSessionEnd(cb),
  },
  soniox: {
    start: (opts) => window.electronAPI.sonioxStreamingStart(opts),
    send: (buf) => window.electronAPI.sonioxStreamingSend(buf),
    finalize: () => window.electronAPI.sonioxStreamingFinalize(),
    stop: () => window.electronAPI.sonioxStreamingStop(),
    status: () => window.electronAPI.sonioxStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onSonioxPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onSonioxFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onSonioxError(cb),
    onSessionEnd: (cb) => window.electronAPI.onSonioxSessionEnd(cb),
  },
  corti: {
    warmup: (opts) => window.electronAPI.cortiStreamingWarmup(opts),
    start: (opts) => window.electronAPI.cortiStreamingStart(opts),
    send: (buf) => window.electronAPI.cortiStreamingSend(buf),
    finalize: () => window.electronAPI.cortiStreamingFinalize(),
    stop: () => window.electronAPI.cortiStreamingStop(),
    status: () => window.electronAPI.cortiStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onCortiPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onCortiFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onCortiError(cb),
    onSessionEnd: (cb) => window.electronAPI.onCortiSessionEnd(cb),
  },
  xai: {
    warmup: (opts) => window.electronAPI.xaiStreamingWarmup(opts),
    start: (opts) => window.electronAPI.xaiStreamingStart(opts),
    send: (buf) => window.electronAPI.xaiStreamingSend(buf),
    finalize: () => window.electronAPI.xaiStreamingFinalize(),
    stop: () => window.electronAPI.xaiStreamingStop(),
    status: () => window.electronAPI.xaiStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onXaiPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onXaiFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onXaiError(cb),
    onSessionEnd: (cb) => window.electronAPI.onXaiSessionEnd(cb),
  },
  "tinfoil-realtime": {
    warmup: (opts) =>
      window.electronAPI.dictationRealtimeWarmup({
        ...opts,
        provider: "tinfoil-realtime",
        preview: true,
      }),
    start: (opts) =>
      window.electronAPI.dictationRealtimeStart({
        ...opts,
        provider: "tinfoil-realtime",
        preview: true,
      }),
    send: (buf) => window.electronAPI.dictationRealtimeSend(buf),
    stop: () => window.electronAPI.dictationRealtimeStop(),
    onPartial: (cb) => window.electronAPI.onDictationRealtimePartial(cb),
    onFinal: (cb) => window.electronAPI.onDictationRealtimeFinal(cb),
    onError: (cb) => window.electronAPI.onDictationRealtimeError(cb),
    onSessionEnd: (cb) => window.electronAPI.onDictationRealtimeSessionEnd(cb),
  },
};

class AudioManager {
  constructor() {
    this.mediaRecorder = null;
    this._batchPcm = [];
    this.audioChunks = [];
    this.isRecording = false;
    this.isProcessing = false;
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.onPartialTranscript = null;
    this.micCaptureStatus = "inactive";
    this.cachedApiKey = null;
    this.cachedApiKeyProvider = null;

    this._onApiKeyChanged = () => {
      this.cachedApiKey = null;
      this.cachedApiKeyProvider = null;
    };
    window.addEventListener("api-key-changed", this._onApiKeyChanged);

    // Invalidate the pinned mic device when the OS adds/removes/suspends inputs.
    // Otherwise wake-after-idle keeps requesting a stale deviceId that yields silence.
    this._onDeviceChange = () => {
      this.cachedMicDeviceId = null;
      this.validatedSelectedMicDeviceId = null;
      this.micDriverWarmedUp = false;
      this.rejectedMicDeviceId = null;
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", this._onDeviceChange);
    this.cachedTranscriptionEndpoint = null;
    this.cachedEndpointProvider = null;
    this.cachedEndpointBaseUrl = null;
    this.recordingStartTime = null;
    this.reasoningAvailabilityCache = { value: false, expiresAt: 0 };
    this.cachedReasoningPreference = null;
    this.isStreaming = false;
    this.streamingAudioContext = null;
    this.streamingSource = null;
    this.streamingProcessor = null;
    this.streamingStream = null;
    this.streamingCleanupFns = [];
    this.streamingFinalText = "";
    this.streamingPartialText = "";
    this.streamingTextResolve = null;
    this.streamingTextDebounce = null;
    this.cachedMicDeviceId = null;
    this.validatedSelectedMicDeviceId = null;
    this.rejectedMicDeviceId = null;
    this.persistentAudioContext = null;
    this.workletModuleLoaded = false;
    this.workletBlobUrl = null;
    this.streamingStartInProgress = false;
    this.stopRequestedDuringStreamingStart = false;
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    this.skipReasoning = false;
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.context = "dictation";
    this.sttConfig = null;
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    this._localSpeechGateState = null;
    this._streamingCommitActive = false;
    this._previewFlushResolve = null;
    this._batchSegments = [];
    this._rotatingBatchRecorder = null;
    this._rotationResolve = null;
    this._stopRequestedDuringMicRecovery = false;
    this._cancelRequestedDuringMicRecovery = false;
    this._streamingFallbackSegments = [];
    this._streamingMicSwapPromise = null;
    this.micRecovery = new ActiveMicRecoveryController({
      mediaDevices: navigator.mediaDevices,
      acquire: async () => {
        try {
          const constraints = await this.getAudioConstraints();
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (error) {
          logger.debug(
            "Preferred mic unavailable during recovery, falling back to default",
            { error: error.message },
            "audio"
          );
          const fallback = await this.getAudioConstraints(true);
          return navigator.mediaDevices.getUserMedia(fallback);
        }
      },
      onRecovered: (replacement, previous) => this.replaceActiveMic(replacement, previous),
      onStatusChange: (status) => this.setMicCaptureStatus(status),
    });
  }

  getWorkletBlobUrl() {
    if (this.workletBlobUrl) return this.workletBlobUrl;
    const code = `
const BUFFER_SIZE = 800;
class PCMStreamingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(BUFFER_SIZE);
    this._offset = 0;
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        if (this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this.port.postMessage(partial.buffer, [partial.buffer]);
          this._buffer = new Int16Array(BUFFER_SIZE);
          this._offset = 0;
        }
        this.port.postMessage("flushed");
        this._stopped = true;
      }
    };
  }
  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset >= BUFFER_SIZE) {
        this.port.postMessage(this._buffer.buffer, [this._buffer.buffer]);
        this._buffer = new Int16Array(BUFFER_SIZE);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-streaming-processor", PCMStreamingProcessor);
`;
    this.workletBlobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    return this.workletBlobUrl;
  }

  // Strips silence before upload. Providers bill by audio duration, and in dual
  // mode every pause is paid for twice.
  //
  // Returns the original blob on any failure or if the plan looks unsafe: a
  // shorter upload is never worth risking a mangled recording, and the caller
  // cannot tell afterwards that audio went missing.
  /**
   * Prepares the recording for upload: mono, optionally silence-trimmed, always 16 kHz.
   *
   * Resampling happens whether or not anything was trimmed. Two reasons: the bytes are
   * three times smaller than the 48 kHz the microphone hands over, and it makes every
   * dictation arrive in the same encoding — previously a trimmed one uploaded WAV while an
   * untrimmed one uploaded the recorder's Opus, and Opus produced *different transcripts*
   * on Groq and xAI in testing, so which path ran changed the text.
   *
   * The bytes do go up for the untrimmed case (Opus is far smaller than PCM), but the
   * measurements say that costs nothing: 16 kHz WAV beat Opus on OpenAI and tied on xAI.
   */
  /**
   * The samples this dictation captured, when they are safe to use in place of decoding.
   *
   * Rotation across a mic change leaves several segments; concatenating them is only
   * correct when every one came back at the same rate, which is why the rate is carried
   * per segment rather than assumed.
   */
  capturedPcmForUpload() {
    const segments = (this._batchPcm || []).filter((entry) => entry?.samples?.length);
    if (segments.length === 0) return null;
    const sampleRate = segments[0].sampleRate;
    if (segments.some((entry) => entry.sampleRate !== sampleRate)) return null;
    return { samples: concatFrames(segments.map((entry) => entry.samples)), sampleRate };
  }

  async prepareAudioForUpload(audioBlob, capturedPcm = null) {
    this._lastTrim = null;
    if (!audioBlob?.size) return audioBlob;
    const trimSettings = getSettings();
    try {
      let mono;
      let sourceRate;
      if (capturedPcm?.samples?.length) {
        // Straight from the microphone: already mono at 16 kHz, so no decode and no
        // resample. Decoding the encoded blob instead would round-trip the audio through
        // the hardware rate for nothing.
        mono = capturedPcm.samples;
        sourceRate = capturedPcm.sampleRate;
      } else {
        const context = new AudioContext();
        let decoded;
        try {
          decoded = await context.decodeAudioData(await audioBlob.arrayBuffer());
        } finally {
          context.close().catch(() => {});
        }

        // Mono: every provider here transcribes a single channel, and mixing down first
        // means the trim plan is computed on what is actually uploaded.
        const channels = decoded.numberOfChannels;
        mono = new Float32Array(decoded.length);
        for (let c = 0; c < channels; c++) {
          const data = decoded.getChannelData(c);
          for (let i = 0; i < decoded.length; i++) mono[i] += data[i] / channels;
        }
        sourceRate = decoded.sampleRate;
      }
      const length = mono.length;
      const decoded = { sampleRate: sourceRate };

      // Trimming is the user's setting; the resample is not, so a disabled trim still
      // gets the smaller, consistent upload.
      let samples = mono;
      let trimmedSeconds = length / decoded.sampleRate;
      let percentRemoved = 0;
      // `=== true`, not `!== false`: the latter treated an absent setting as enabled,
      // which is a second default and now the opposite of the store's.
      if (trimSettings.silenceTrimEnabled === true) {
        const plan = planSilenceTrim(
          mono,
          decoded.sampleRate,
          resolveSilenceTrimOptions(trimSettings.silenceTrimStrength)
        );
        if (plan.trimmed) {
          samples = applySilenceTrim(mono, plan);
          trimmedSeconds = samples.length / decoded.sampleRate;
          percentRemoved = Math.round(((length - samples.length) / length) * 100);
        } else {
          logger.debug(
            "Silence trim skipped",
            {
              reason: plan.reason || "unknown",
              threshold: plan.threshold?.toFixed(5),
              seconds: +(length / decoded.sampleRate).toFixed(2),
            },
            "transcription"
          );
        }
      }

      const resampled = await resampleForUpload(samples, decoded.sampleRate);

      // After the resample, so the level is measured on exactly the samples that get
      // uploaded, and on the fewest of them. After the trim too, so the trim's own
      // adaptive threshold still sees the original levels it was tuned against.
      //
      // `=== false` rather than a truthy check: an absent setting must mean the default,
      // not off, or this becomes a second default that disagrees with the store's.
      const gainPlan =
        trimSettings.autoGainEnabled === false
          ? { gain: 1, applied: false, speechRms: 0, reason: "disabled" }
          : planAutoGain(resampled.samples, resampled.sampleRate);
      const wav = encodeWavPcm16(resampled.samples, resampled.sampleRate, gainPlan.gain);

      // Reported even at 0%, so the stats readout can tell "nothing to trim" apart from
      // "trimming did not run".
      this._lastTrim = {
        originalSeconds: length / decoded.sampleRate,
        trimmedSeconds,
        percentRemoved,
      };
      logger.info(
        "Audio prepared for upload",
        {
          originalSeconds: +(length / decoded.sampleRate).toFixed(2),
          trimmedSeconds: +trimmedSeconds.toFixed(2),
          percentRemoved,
          fromSampleRate: decoded.sampleRate,
          toSampleRate: resampled.sampleRate,
          originalBytes: audioBlob.size,
          uploadBytes: wav.size,
          // Reported even when it did nothing, with the reason, so "the level was fine"
          // is distinguishable from "gain never ran".
          gain: +gainPlan.gain.toFixed(2),
          gainReason: gainPlan.reason ?? "applied",
          speechRms: +gainPlan.speechRms.toFixed(4),
        },
        "transcription"
      );
      return wav;
    } catch (error) {
      logger.debug(
        "Audio preparation failed, uploading as recorded",
        { error: error.message },
        "transcription"
      );
      return audioBlob;
    }
  }

  getCustomDictionaryPrompt() {
    const words = getDictionaryHintWords(getSettings());
    return words.length > 0 ? words.join(", ") : null;
  }

  isDictionaryEcho(text) {
    // Against the prompt actually sent, when there was one: the prompt now carries the
    // on-screen terms too, and rebuilding a dictionary-only string here would compare the
    // transcript against something the provider never saw.
    return matchesDictionaryPrompt(
      text,
      this._lastDictationPrompt ?? this.getCustomDictionaryPrompt()
    );
  }

  setCallbacks({
    onStateChange,
    onError,
    onTranscriptionComplete,
    onPartialTranscript,
    onStreamingCommit,
    onTranslationFallback,
    onScreenContextBlocked,
  }) {
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onTranscriptionComplete = onTranscriptionComplete;
    this.onPartialTranscript = onPartialTranscript;
    this.onStreamingCommit = onStreamingCommit;
    this.onTranslationFallback = onTranslationFallback;
    this.onScreenContextBlocked = onScreenContextBlocked;
  }

  // Fail-open: translation degraded/failed but raw text is still pasted. Surface why.
  notifyTranslationFallback(reason) {
    this.onTranslationFallback?.({ reason });
  }

  setMicCaptureStatus(status) {
    if (this.micCaptureStatus === status) return;
    this.micCaptureStatus = status;
    this.onStateChange?.({
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      isStreaming: this.isStreaming,
      micCaptureStatus: status,
    });
  }

  async beginMicRecovery(stream) {
    // A stop/cancel can land during the awaits between recorder start and this
    // call; never arm recovery for a recording that already ended.
    if (!this.isRecording) return;
    await this.micRecovery.start(stream, {
      followDefault: followsSystemDefaultMic(getSettings()),
    });
  }

  async replaceActiveMic(replacement, previous) {
    if (!this.isRecording) throw new Error("Recording is no longer active");
    if (this.isStreaming) {
      await this.replaceStreamingMic(replacement, previous);
    } else {
      await this.replaceBatchMic(replacement, previous);
    }
  }

  async mergeRecordedSegments(segments) {
    // Header-only segments carry no audio frames and crash FFmpeg's concat (#871).
    const usable = segments.filter((segment) => segment && !isEmptyRecording(segment.size));
    if (usable.length === 0) return null;
    if (usable.length === 1) return usable[0];
    const payload = await Promise.all(
      usable.map(async (segment) => ({
        buffer: await segment.arrayBuffer(),
        mimeType: segment.type || "audio/webm",
      }))
    );
    const result = await window.electronAPI.mergeAudioSegments(payload);
    if (!result?.success) throw new Error(result?.error || "Failed to merge audio segments");
    return new Blob([result.buffer], { type: result.mimeType });
  }

  getLargestRecordedSegment(segments) {
    return segments
      .filter((segment) => segment && !isEmptyRecording(segment.size))
      .reduce(
        (largest, segment) => (segment.size > (largest?.size || 0) ? segment : largest),
        null
      );
  }

  setSkipReasoning(skip) {
    this.skipReasoning = skip;
  }

  setVoiceAgentRequested(requested) {
    this.voiceAgentRequested = requested;
  }

  setTranslationRequested(requested) {
    this.translationRequested = requested;
  }

  // In translation mode the STT hint is the configured source language, not
  // the UI-wide preferred language; "auto" keeps whisper auto-detection.
  getEffectiveSttLanguage(settings) {
    if (this.translationRequested) {
      return (
        settings.translationSourceLanguage ||
        settingsDefaults.storeDefaults.translationSourceLanguage
      );
    }
    return settings.preferredLanguage;
  }

  setContext(context) {
    this.context = context;
  }

  setSttConfig(config) {
    this.sttConfig = config;
  }

  getStreamingProvider() {
    const fallback = this.context === "notes" ? "deepgram" : "openai-realtime";
    return STREAMING_PROVIDERS[this.getStreamingProviderName()] || STREAMING_PROVIDERS[fallback];
  }

  getStreamingProviderName() {
    const s = getSettings();
    if (s.cloudTranscriptionProvider === "tinfoil") {
      return "tinfoil-realtime";
    }
    if (s.cloudTranscriptionProvider === "corti" && s.cloudTranscriptionMode === "byok") {
      return "corti";
    }
    // Table-driven: every provider that serves both a socket and a one-shot API picks
    // between them from its own mode setting, so adding one is an entry in
    // STREAMING_CAPABLE_PROVIDERS rather than another branch here.
    if (
      s.cloudTranscriptionMode === "byok" &&
      providerWantsStreaming(s.cloudTranscriptionProvider, s)
    ) {
      return STREAMING_PROVIDER_BY_TRANSCRIPTION_PROVIDER[s.cloudTranscriptionProvider];
    }
    if (REALTIME_MODELS.has(s.cloudTranscriptionModel)) {
      return "openai-realtime";
    }
    const defaultProvider = this.context === "notes" ? "deepgram" : "openai-realtime";
    return this.sttConfig?.streamingProvider || defaultProvider;
  }

  async getAudioConstraints(forceDefaultMic = false) {
    const {
      preferBuiltInMic: preferBuiltIn,
      selectedMicDeviceId: selectedDeviceId,
      selectedMicDeviceLabel: selectedDeviceLabel,
    } = getSettings();

    // All browser audio processing disabled to avoid OS-level side-effects.
    // AGC off: Chromium's AGC on Windows mutates the system mic volume via WASAPI (#476).
    // Echo cancellation and noise suppression off to avoid latency and speech distortion.
    // Stereo recording required — mono WebM breaks silence detection on Linux/PipeWire (#472).
    const noProcessing = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    };

    // Pinned device was unavailable (Chromium rotates IDs / device unplugged); fall back to the
    // system default for this capture without discarding the saved preference. See #900.
    if (forceDefaultMic) {
      logger.debug("Using default microphone (pinned device unavailable)", {}, "audio");
      return { audio: noProcessing };
    }

    if (preferBuiltIn) {
      if (this.cachedMicDeviceId) {
        // The device was already proven silent this session; don't pin it again.
        if (this.cachedMicDeviceId === this.rejectedMicDeviceId) {
          logger.debug(
            "Skipping cached microphone (delivered no audio)",
            { deviceId: this.cachedMicDeviceId },
            "audio"
          );
          return { audio: noProcessing };
        }

        logger.debug(
          "Using cached microphone device ID",
          { deviceId: this.cachedMicDeviceId },
          "audio"
        );
        return { audio: { deviceId: { exact: this.cachedMicDeviceId }, ...noProcessing } };
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");
        const builtInMic = audioInputs.find((d) => isBuiltInMicrophone(d.label));

        if (builtInMic) {
          // Leave it uncached so a later devicechange can re-resolve it cleanly.
          if (builtInMic.deviceId === this.rejectedMicDeviceId) {
            logger.debug(
              "Skipping built-in microphone (delivered no audio)",
              { deviceId: builtInMic.deviceId, label: builtInMic.label },
              "audio"
            );
            return { audio: noProcessing };
          }

          this.cachedMicDeviceId = builtInMic.deviceId;
          logger.debug(
            "Using built-in microphone (cached for next time)",
            { deviceId: builtInMic.deviceId, label: builtInMic.label },
            "audio"
          );
          return { audio: { deviceId: { exact: builtInMic.deviceId }, ...noProcessing } };
        }
      } catch (error) {
        logger.debug(
          "Failed to enumerate devices for built-in mic detection",
          { error: error.message },
          "audio"
        );
      }
    }

    if (!preferBuiltIn && selectedDeviceId) {
      let resolvedDeviceId = selectedDeviceId;

      if (this.validatedSelectedMicDeviceId !== selectedDeviceId) {
        try {
          const reconciled = await reconcileSavedMicSelection(
            selectedDeviceId,
            selectedDeviceLabel,
            "audio"
          );
          resolvedDeviceId = reconciled.deviceId;

          if (reconciled.resolved) {
            this.validatedSelectedMicDeviceId = resolvedDeviceId;
          } else {
            // Avoid enumerating on every recording while the saved device is
            // unplugged. A devicechange event clears this cache when it returns.
            this.validatedSelectedMicDeviceId = reconciled.labelsAvailable
              ? selectedDeviceId
              : null;
          }
        } catch (error) {
          logger.debug(
            "Failed to reconcile selected microphone",
            { error: error.message },
            "audio"
          );
        }
      }

      if (resolvedDeviceId === this.rejectedMicDeviceId) {
        logger.debug(
          "Skipping selected microphone (delivered no audio)",
          { deviceId: resolvedDeviceId },
          "audio"
        );
        return { audio: noProcessing };
      }

      logger.debug("Using selected microphone", { deviceId: resolvedDeviceId }, "audio");
      return { audio: { deviceId: { exact: resolvedDeviceId }, ...noProcessing } };
    }

    logger.debug("Using default microphone", {}, "audio");
    return { audio: noProcessing };
  }

  async cacheMicrophoneDeviceId() {
    if (this.cachedMicDeviceId) return; // Already cached

    if (!getSettings().preferBuiltInMic) return; // Only needed for built-in mic detection

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === "audioinput");
      const builtInMic = audioInputs.find((d) => isBuiltInMicrophone(d.label));
      if (builtInMic) {
        this.cachedMicDeviceId = builtInMic.deviceId;
        logger.debug("Microphone device ID pre-cached", { deviceId: builtInMic.deviceId }, "audio");
      }
    } catch (error) {
      logger.debug("Failed to pre-cache microphone device ID", { error: error.message }, "audio");
    }
  }

  // Briefly acquire and release the mic so the OS audio driver is warm before
  // the first real recording, reducing cold-start empty captures. See #871.
  async warmupMicDriver() {
    if (this.micDriverWarmedUp) return;
    // Skip while a recording is active so we don't double-acquire the mic. See #871.
    if (this.isRecording || this.isProcessing || this.mediaRecorder?.state === "recording") return;
    try {
      const constraints = await this.getAudioConstraints();
      const tempStream = await navigator.mediaDevices.getUserMedia(constraints);
      tempStream.getTracks().forEach((track) => track.stop());
      this.micDriverWarmedUp = true;
      logger.debug("Microphone driver pre-warmed", {}, "audio");
    } catch (e) {
      logger.debug("Mic driver warmup failed (non-critical)", { error: e.message }, "audio");
    }
  }

  // Recovers a dead/muted capture: retries the same device, then hops to the OS default,
  // remembering a silent pinned device for the session. Throws MicUnusableError when no
  // input delivers audio. See #1152.
  async acquireHealthyMicStream(rawStream, constraints) {
    const pinnedMicDeviceId = constraints.audio?.deviceId?.exact ?? null;
    let fallbackMicUnusable = false;
    // Keep verifying after a rejection too, otherwise a muted default records silence unnoticed.
    const verifyMic = pinnedMicDeviceId !== null || this.rejectedMicDeviceId !== null;
    const stream = await reacquireIfDead(
      rawStream,
      () => {
        this.cachedMicDeviceId = null;
        return this.getAudioConstraints();
      },
      logger,
      verifyMic
        ? {
            getConstraints: () => this.getAudioConstraints(true),
            onDeviceRejected: () => {
              if (pinnedMicDeviceId) this.rejectedMicDeviceId = pinnedMicDeviceId;
            },
            onFallbackUnusable: () => {
              fallbackMicUnusable = true;
            },
          }
        : null
    );

    if (fallbackMicUnusable) {
      stream.getTracks().forEach((track) => track.stop());
      const micError = new Error("No microphone is delivering audio");
      micError.name = "MicUnusableError";
      throw micError;
    }

    return stream;
  }

  async startRecording(forceDefaultMic = false) {
    try {
      if (this.isRecording || this.isProcessing || this.mediaRecorder?.state === "recording") {
        return false;
      }

      // Fire and forget, before the mic is even acquired: OCR then runs while
      // the user speaks instead of adding latency at the end.
      this.startScreenContextCapture();

      const constraints = await this.getAudioConstraints(forceDefaultMic);
      const micStream = await this.acquireHealthyMicStream(
        await navigator.mediaDevices.getUserMedia(constraints),
        constraints
      );

      const audioTrack = micStream.getAudioTracks()[0];

      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
            muted: audioTrack.muted,
            readyState: audioTrack.readyState,
          },
          "audio"
        );
      }

      try {
        this._silenceCtx = new AudioContext();
        if (this._silenceCtx.state === "suspended") {
          // Not awaited — resume() can hang when the output device is wedged.
          this._silenceCtx.resume().catch(() => {});
        }
        this._silenceAnalyser = this._silenceCtx.createAnalyser();
        this._silenceAnalyser.fftSize = 2048;
        this._silenceSource = this._silenceCtx.createMediaStreamSource(micStream);
        this._silenceSource.connect(this._silenceAnalyser);
        this._localSpeechGateState = createLocalSpeechGateState();
        const dataArray = new Uint8Array(this._silenceAnalyser.fftSize);
        this._silenceInterval = setInterval(() => {
          // A stalled context reads flat silence; recording no windows fails the gate open.
          if (this._silenceCtx?.state !== "running") return;
          this._silenceAnalyser.getByteTimeDomainData(dataArray);
          let sum = 0;
          let peak = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const v = (dataArray[i] - 128) / 128;
            sum += v * v;
            const abs = Math.abs(v);
            if (abs > peak) peak = abs;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          recordLocalSpeechWindow(this._localSpeechGateState, rms, peak);
        }, 100);
      } catch (e) {
        logger.warn("Audio level gate setup failed, skipping", { error: e.message }, "audio");
        this._localSpeechGateState = null;
      }

      this.audioChunks = [];
      this._batchSegments = [];
      this._stopRequestedDuringMicRecovery = false;
      this._cancelRequestedDuringMicRecovery = false;
      this._receivedAudioData = false;
      this.recordingStartTime = Date.now();
      this.createBatchRecorder(micStream);
      this.isRecording = true;
      this.onStateChange?.({
        isRecording: true,
        isProcessing: false,
        micCaptureStatus: "active",
      });

      const {
        showTranscriptionPreview,
        useLocalWhisper,
        localTranscriptionProvider,
        whisperModel,
        parakeetModel,
      } = getSettings();
      const isNvidia = localTranscriptionProvider === "nvidia";
      // Online models stream+commit during capture, so PCM runs even with preview off.
      const streamingCommit = useLocalWhisper && isNvidia && isOnlineParakeetModel(parakeetModel);
      this._streamingCommitActive = false;
      if (useLocalWhisper && (showTranscriptionPreview || streamingCommit)) {
        try {
          this._previewAudioContext = new AudioContext({ sampleRate: 16000 });
          this._previewSource = this._previewAudioContext.createMediaStreamSource(micStream);
          await this._previewAudioContext.audioWorklet.addModule(this.getWorkletBlobUrl());

          this._previewProcessor = new AudioWorkletNode(
            this._previewAudioContext,
            "pcm-streaming-processor"
          );
          this._previewProcessor.port.onmessage = (event) => {
            if (event.data === "flushed") {
              this._previewFlushResolve?.();
              return;
            }
            window.electronAPI?.sendDictationPreviewAudio?.(event.data);
          };
          this._previewSource.connect(this._previewProcessor);

          const provider = isNvidia ? "nvidia" : "whisper";
          const model = isNvidia ? parakeetModel : whisperModel;
          const language = getBaseLanguageCode(getSettings().preferredLanguage);
          window.electronAPI?.startDictationPreview?.({
            provider,
            model,
            language,
            display: showTranscriptionPreview,
          });
          this._streamingCommitActive = streamingCommit;
        } catch (e) {
          logger.warn("Preview worklet setup failed", { error: e.message }, "audio");
        }
      }

      await this.beginMicRecovery(micStream);

      return true;
    } catch (error) {
      if (isStaleDeviceError(error) && !forceDefaultMic) {
        // Pinned mic is gone (Chromium rotates IDs / device unplugged). Retry once on the default mic. See #900.
        logger.warn("Pinned microphone unavailable, retrying on default mic", {}, "audio");
        this.cachedMicDeviceId = null;
        return this.startRecording(true);
      }

      let errorTitle = "Recording Error";
      let errorDescription = `Failed to access microphone: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        errorTitle = "No Microphone Found";
        errorDescription = "No microphone was detected. Please connect a microphone and try again.";
      } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        errorTitle = "Microphone In Use";
        errorDescription =
          "The microphone is being used by another application. Please close other apps and try again.";
      } else if (error.name === "MicUnusableError") {
        errorTitle = "Microphone Muted";
        errorDescription =
          "Your microphones stayed muted and produced no audio. Please check your sound input settings and try again.";
      }

      this.onError?.({
        title: errorTitle,
        description: errorDescription,
      });
      return false;
    }
  }

  createBatchRecorder(micStream) {
    // 16 kHz mono PCM, captured rather than encoded: see pcmBatchRecorder for why Opus is
    // gone. The interface matches what this path expected of MediaRecorder, so rotation,
    // cancel and discard behaviour below are unchanged.
    const recorder = new PcmBatchRecorder(micStream, () => {
      this._receivedAudioData = true;
    });
    this.mediaRecorder = recorder;
    this.audioChunks = [];
    this.recordingMimeType = "audio/wav";
    if (!this._rotatingBatchRecorder) this._batchPcm = [];

    recorder.onstop = async ({ blob, samples, sampleRate }) => {
      const segment = blob;
      // Kept so the upload path can trim these samples directly. Decoding the WAV back
      // would upsample it to the hardware rate — decodeAudioData resamples to its
      // context — and then it would have to be downsampled again to reach 16 kHz.
      this._batchPcm.push({ samples, sampleRate });
      const rotating = this._rotatingBatchRecorder === recorder;
      // A dying mic used to stop MediaRecorder on its own; the PCM recorder has to be
      // stopped explicitly, which micRecovery does. Either way, while recovery is armed a
      // stop means "bank this segment and keep the recording alive for the new mic".
      if (rotating || this.micRecovery.started) {
        if (!isEmptyRecording(segment.size)) this._batchSegments.push(segment);
        micStream.getTracks().forEach((track) => track.stop());
        if (rotating) {
          this._rotatingBatchRecorder = null;
          this._rotationResolve?.();
          this._rotationResolve = null;
        } else {
          void this.micRecovery.recover("recorder-stopped");
        }
        return;
      }

      micStream.getTracks().forEach((track) => track.stop());
      await this.finalizeBatchRecording(segment);
    };

    // Asynchronous, unlike MediaRecorder.start(): the worklet module has to load first.
    // Failing here leaves isRecording true with nothing capturing, so it is surfaced the
    // same way a mic error is rather than swallowed.
    recorder.start().catch((error) => {
      logger.error("PCM recorder failed to start", { error: error.message }, "audio");
      this.onError?.({
        title: "Recording Error",
        description: `Could not start the microphone: ${error.message}`,
      });
      this.isRecording = false;
      this.onStateChange?.({
        isRecording: false,
        isProcessing: false,
        micCaptureStatus: "inactive",
      });
    });
    return recorder;
  }

  async finalizeBatchRecording(finalSegment) {
    this.micRecovery.stop();
    this.teardownSpeechGate();
    const previewStopPromise = this.cleanupPreview({
      showCleanup: this.shouldShowPreviewCleanupState(),
    });
    this.isRecording = false;
    this.isProcessing = true;
    this.onStateChange?.({
      isRecording: false,
      isProcessing: true,
      micCaptureStatus: "inactive",
    });

    const segments = finalSegment ? [...this._batchSegments, finalSegment] : this._batchSegments;
    this._batchSegments = [];
    const segmentsCount = segments.filter((segment) => segment?.size > 0).length;
    let audioBlob = null;
    try {
      audioBlob = await this.mergeRecordedSegments(segments);
    } catch (error) {
      logger.error("Failed to assemble recovered recording", { error: error.message }, "audio");
      // Salvage the largest segment rather than dropping the whole recording.
      audioBlob = this.getLargestRecordedSegment(segments);
    }
    audioBlob = audioBlob || new Blob([], { type: this.recordingMimeType || "audio/wav" });
    this.lastAudioBlob = audioBlob;

    logger.info(
      "Recording stopped",
      {
        blobSize: audioBlob.size,
        blobType: audioBlob.type,
        segmentsCount,
      },
      "audio"
    );

    const durationSeconds = this.recordingStartTime
      ? (Date.now() - this.recordingStartTime) / 1000
      : null;
    this.recordingStartTime = null;
    const recordingCheck = evaluateFinishedRecording({
      blobSize: audioBlob.size,
      receivedAudioData: this._receivedAudioData,
    });
    if (!recordingCheck.usable) {
      logger.info(
        "Dropping degenerate recording before transcription",
        {
          blobSize: audioBlob.size,
          reason: recordingCheck.reason,
          receivedAudioData: this._receivedAudioData,
        },
        "audio"
      );
      this.isProcessing = false;
      this._localSpeechGateState = null;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      this.onTranscriptionComplete?.({ success: true, text: "" });
      return;
    }
    // Non-commit sessions stop concurrently with the decode below.
    const previewStop = this._streamingCommitActive ? await previewStopPromise : null;
    this._streamingCommitActive = false;

    await this.processAudio(audioBlob, {
      durationSeconds,
      ...(previewStop?.streamed ? { streamedText: previewStop.text } : {}),
    });
  }

  async replaceBatchMic(replacement) {
    try {
      const recorder = this.mediaRecorder;
      if (!recorder) throw new Error("Batch recorder is no longer active");
      // An auto-stopped recorder (mic track died) already banked its segment in
      // onstop; only a live recorder needs the explicit rotation handshake.
      if (recorder.state === "recording") {
        await new Promise((resolve) => {
          this._rotatingBatchRecorder = recorder;
          this._rotationResolve = resolve;
          recorder.stop();
        });
      }
      if (!this.isRecording) throw new Error("Recording stopped during microphone recovery");

      this._silenceSource?.disconnect();
      if (this._silenceCtx && this._silenceAnalyser) {
        this._silenceSource = this._silenceCtx.createMediaStreamSource(replacement);
        this._silenceSource.connect(this._silenceAnalyser);
      }
      this._previewSource?.disconnect();
      if (this._previewAudioContext && this._previewProcessor) {
        this._previewSource = this._previewAudioContext.createMediaStreamSource(replacement);
        this._previewSource.connect(this._previewProcessor);
      }
      this.createBatchRecorder(replacement);
    } finally {
      // Honor a stop/cancel that arrived mid-rotation even when the swap failed —
      // dropping it would leave an unstoppable recording (isRecording stuck true).
      const cancelRequested = this._cancelRequestedDuringMicRecovery;
      const stopRequested = this._stopRequestedDuringMicRecovery;
      this._cancelRequestedDuringMicRecovery = false;
      this._stopRequestedDuringMicRecovery = false;
      if (cancelRequested) this.cancelRecording();
      else if (stopRequested) this.stopRecording();
    }
  }

  stopRecording() {
    this.micRecovery.stop();
    if (this._rotatingBatchRecorder) {
      this._stopRequestedDuringMicRecovery = true;
      return true;
    }
    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.stop();
      return true;
    }
    if (this.isRecording && !this.isStreaming) {
      // The mic died mid-recovery, so no live recorder exists; finalize what
      // was captured instead of leaving the recording unstoppable.
      void this.finalizeBatchRecording(null);
      return true;
    }
    return false;
  }

  teardownSpeechGate() {
    if (this._silenceInterval) {
      clearInterval(this._silenceInterval);
      this._silenceInterval = null;
    }
    this._silenceCtx?.close().catch(() => {});
    this._silenceCtx = null;
    this._silenceAnalyser = null;
    this._silenceSource = null;
  }

  cancelRecording() {
    this.micRecovery.stop();
    if (this._rotatingBatchRecorder) {
      this._cancelRequestedDuringMicRecovery = true;
      return true;
    }
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      const recorder = this.mediaRecorder;
      const discarded = this.takeDiscardedBatchSnapshot();
      this.mediaRecorder.onstop = () => {
        recorder.stream?.getTracks().forEach((track) => track.stop());
        this.persistDiscardedBatchRecording(discarded);
      };

      // Detach from manager state before recorder.stop(): its final
      // dataavailable/onstop land async and must not block or observe the
      // next recording.
      this.resetDiscardedBatchRecordingState();

      recorder.stop();

      if (recorder.stream) {
        recorder.stream.getTracks().forEach((track) => track.stop());
      }

      return true;
    }
    if (this.isRecording && !this.isStreaming) {
      // The mic died mid-recovery, so no live recorder exists; discard what was
      // captured instead of leaving the recording uncancelable.
      this.discardBatchRecording();
      return true;
    }
    return false;
  }

  discardBatchRecording() {
    const discarded = this.takeDiscardedBatchSnapshot();
    this.resetDiscardedBatchRecordingState();
    this.persistDiscardedBatchRecording(discarded);
  }

  takeDiscardedBatchSnapshot() {
    return {
      durationSeconds: this.recordingStartTime
        ? (Date.now() - this.recordingStartTime) / 1000
        : null,
      chunks: this.audioChunks,
      segments: this._batchSegments,
      mimeType: this.recordingMimeType,
    };
  }

  resetDiscardedBatchRecordingState() {
    // This dictation produces no transcript, so its capture has no consumer.
    this.cancelScreenContextCapture();
    this.teardownSpeechGate();
    this._localSpeechGateState = null;

    this.cleanupPreview({ dismiss: true });
    this.isRecording = false;
    this.isProcessing = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this._batchSegments = [];
    this.recordingStartTime = null;
    this.onStateChange?.({ isRecording: false, isProcessing: false });
  }

  persistDiscardedBatchRecording({ durationSeconds, chunks, segments, mimeType }) {
    // This must run after MediaRecorder's final dataavailable event, so decide
    // whether to retain the discarded audio from the snapshot rather than live
    // manager state (which may already belong to a new recording).
    const shouldSave =
      shouldSaveDiscardedRecording(getSettings(), durationSeconds) &&
      (chunks.length > 0 || segments.length > 0);
    if (shouldSave) {
      // Assemble and save in the background — the merge crosses IPC into FFmpeg
      // and must not delay the recorder becoming available again.
      void (async () => {
        try {
          const current = new Blob(chunks, { type: mimeType });
          const blob = await this.mergeRecordedSegments([...segments, current]);
          if (blob) await this.saveDiscardedTranscription(blob, durationSeconds);
        } catch (error) {
          const fallback = this.getLargestRecordedSegment([
            ...segments,
            new Blob(chunks, { type: mimeType }),
          ]);
          if (fallback) {
            try {
              await this.saveDiscardedTranscription(fallback, durationSeconds);
            } catch (fallbackError) {
              logger.warn(
                "Failed to save discarded recording fallback",
                { error: fallbackError.message },
                "audio"
              );
            }
            return;
          }
          logger.warn("Failed to save discarded recording", { error: error.message }, "audio");
        }
      })();
    }
  }

  cancelProcessing() {
    if (this.isProcessing) {
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      return true;
    }
    return false;
  }

  async processAudio(audioBlob, metadata = {}) {
    const pipelineStart = performance.now();
    const settings = getSettings();
    const speechGateDecision = getLocalSpeechGateDecision(this._localSpeechGateState);
    this._localSpeechGateState = null;

    const shouldUseStrongLocalWhisperGate =
      settings.useLocalWhisper && settings.localTranscriptionProvider === "whisper";
    if (
      speechGateDecision.skip &&
      (speechGateDecision.reason === "silence" || shouldUseStrongLocalWhisperGate)
    ) {
      logger.info(
        "Speech gate skipped transcription",
        {
          reason: speechGateDecision.reason,
          useLocalWhisper: settings.useLocalWhisper,
          localProvider: settings.localTranscriptionProvider,
          peakRms: speechGateDecision.peakRms?.toFixed(4),
          peakAmplitude: speechGateDecision.peakAmplitude?.toFixed(4),
          speechWindowCount: speechGateDecision.speechWindowCount,
          maxConsecutiveSpeechWindows: speechGateDecision.maxConsecutiveSpeechWindows,
        },
        "audio"
      );
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      this.onTranscriptionComplete?.({ success: true, text: "" });
      return;
    }

    try {
      const useLocalWhisper = settings.useLocalWhisper;
      const localProvider = settings.localTranscriptionProvider;
      const whisperModel = settings.whisperModel;
      const parakeetModel =
        settings.parakeetModel || settingsDefaults.resolutionDefaults.parakeetModel;

      const cloudTranscriptionMode = settings.cloudTranscriptionMode;
      const isSignedIn = settings.isSignedIn;

      const isOpenWhisprCloudMode = !useLocalWhisper && cloudTranscriptionMode === "openwhispr";
      const useCloud = isOpenWhisprCloudMode && isSignedIn;
      logger.debug(
        "Transcription routing",
        { useLocalWhisper, useCloud, isSignedIn, cloudTranscriptionMode },
        "transcription"
      );

      let result;
      let activeModel;
      if (useLocalWhisper) {
        if (localProvider === "nvidia") {
          activeModel = parakeetModel;
          result = await this.processWithLocalParakeet(audioBlob, parakeetModel, metadata);
        } else {
          activeModel = whisperModel;
          result = await this.processWithLocalWhisper(audioBlob, whisperModel, metadata);
        }
      } else if (isOpenWhisprCloudMode) {
        if (!isSignedIn) {
          const err = new Error(
            "OpenWhispr Cloud requires sign-in. Please sign in again or switch to BYOK mode."
          );
          err.code = "AUTH_REQUIRED";
          err.messageKey = "hooks.audioRecording.errorDescriptions.sessionExpired";
          throw err;
        }
        activeModel = "openwhispr-cloud";
        result = await this.processWithOpenWhisprCloud(audioBlob, metadata);
      } else if (isMultiTranscriptionEnabled(settings)) {
        activeModel = "multi";
        result = await this.processWithMultiTranscription(audioBlob, metadata);
      } else {
        activeModel = this.getTranscriptionModel();
        result = await this.processWithOpenAIAPI(audioBlob, metadata);
      }

      if (!this.isProcessing) {
        return;
      }

      this.lastAudioMetadata = {
        // Named for what was actually captured: retry uploads this file, and a provider
        // rejects a payload whose extension disagrees with its bytes.
        mimeType: audioBlob?.type || this.recordingMimeType || "audio/wav",
        durationMs: metadata?.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : Math.round(performance.now() - pipelineStart),
        provider: result?.source || (useLocalWhisper ? localProvider : "cloud"),
        model: activeModel || null,
      };

      // Everything the stats readout needs, measured here so it covers the whole
      // pipeline rather than any one provider's slice. pipelineStart is taken as
      // the recording stops, so latencyMs is the wait the user actually felt.
      if (result?.success) {
        result.stats = {
          recordedSeconds: metadata?.durationSeconds ?? null,
          latencyMs: Math.round(performance.now() - pipelineStart),
          // Absent when nothing was trimmed, so the row only appears when it
          // actually says something.
          trimmedPercent: this._lastTrim?.percentRemoved ?? null,
          // Whichever provider actually transcribed, so the readout can name it
          // instead of saying "Transcription". Read from the same settings the
          // pickers write, so a provider added to the registry labels itself.
          // Null for dual, which reports a provider per side of the pair.
          provider: activeModel === "multi" ? null : resolveActiveTranscriptionProvider(settings),
          ...(result.timings || {}),
        };

        // Multi records a sample per lane inside processWithMultiTranscription, where the
        // per-provider timings live; every other path has exactly one leg to record here.
        if (activeModel !== "multi") {
          this.recordModelLatency(
            "transcription",
            resolveActiveTranscriptionProvider(settings),
            activeModel || null,
            result.timings?.transcriptionProcessingDurationMs
          );
        }
      }

      this.onTranscriptionComplete?.(result);

      if (result?.source === "openwhispr") {
        window.dispatchEvent(new Event("usage-changed"));
      }

      const roundTripDurationMs = Math.round(performance.now() - pipelineStart);

      const timingData = {
        mode: useLocalWhisper ? `local-${localProvider}` : "cloud",
        model: activeModel,
        audioDurationMs: metadata.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : null,
        reasoningProcessingDurationMs: result?.timings?.reasoningProcessingDurationMs ?? null,
        roundTripDurationMs,
        audioSizeBytes: audioBlob.size,
        audioFormat: audioBlob.type,
        outputTextLength: result?.text?.length,
      };

      if (useLocalWhisper) {
        timingData.audioConversionDurationMs = result?.timings?.audioConversionDurationMs ?? null;
      }
      timingData.transcriptionProcessingDurationMs =
        result?.timings?.transcriptionProcessingDurationMs ?? null;

      logger.info("Pipeline timing", timingData, "performance");
    } catch (error) {
      const errorAtMs = Math.round(performance.now() - pipelineStart);

      logger.error(
        "Pipeline failed",
        {
          errorAtMs,
          error: error.message,
        },
        "performance"
      );

      if (error.message !== "No audio detected") {
        this.onError?.({
          title: "Transcription Error",
          description: `Transcription failed: ${error.message}`,
          code: error.code,
          messageKey: error.messageKey,
        });

        // Counts against that provider's failure rate: a single-provider failure is the
        // same event as a dual side failing, and dual mode is not the only place worth
        // knowing a backend is unreliable.
        this.recordModelLatency(
          "transcription",
          resolveActiveTranscriptionProvider(getSettings()),
          this.lastAudioMetadata?.model || null,
          null,
          "failed"
        );

        // Save failed transcription with audio so the user can retry later
        if (this.lastAudioBlob) {
          this.saveFailedTranscription(error.message, error.code || null, metadata);
        }
      }
    } finally {
      if (this.isProcessing) {
        this.isProcessing = false;
        this.onStateChange?.({ isRecording: false, isProcessing: false });
      }
    }
  }

  async processWithLocalWhisper(audioBlob, model = "base", metadata = {}) {
    const timings = {};

    try {
      // Send original audio to main process - FFmpeg in main process handles conversion
      // (renderer-side AudioContext conversion was unreliable with WebM/Opus format)
      const arrayBuffer = await audioBlob.arrayBuffer();
      const language = getBaseLanguageCode(this.getEffectiveSttLanguage(getSettings()));
      const options = { model };
      if (language) {
        options.language = language;
      }

      // Add custom dictionary as initial prompt to help Whisper recognize specific words
      const dictionaryPrompt = this.getCustomDictionaryPrompt();
      if (dictionaryPrompt) {
        options.initialPrompt = dictionaryPrompt;
      }

      logger.debug(
        "Local transcription starting",
        {
          audioFormat: audioBlob.type,
          audioSizeBytes: audioBlob.size,
        },
        "performance"
      );

      const transcriptionStart = performance.now();
      const result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );

      logger.debug(
        "Local transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          success: result.success,
        },
        "performance"
      );

      if (result.success && result.text) {
        if (this.isDictionaryEcho(result.text)) {
          throw new Error("No audio detected");
        }
        const rawText = result.text;
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return { success: true, text: text || result.text, rawText, source: "local", timings };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Local Whisper transcription failed");
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const { allowOpenAIFallback, useLocalWhisper: isLocalMode } = getSettings();

      if (allowOpenAIFallback && isLocalMode) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          throw new Error(
            `Local Whisper failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Local Whisper failed: ${error.message}`);
      }
    }
  }

  async processWithLocalParakeet(
    audioBlob,
    model = settingsDefaults.resolutionDefaults.parakeetModel,
    metadata = {}
  ) {
    const timings = {};

    try {
      let result;
      const streamedText =
        typeof metadata.streamedText === "string" ? metadata.streamedText.trim() : null;
      // An empty stream is indistinguishable from silence; let the offline decode settle it.
      if (streamedText) {
        logger.debug("Parakeet using committed streaming transcript", { model }, "performance");
        timings.transcriptionProcessingDurationMs = 0;
        result = { success: true, text: streamedText };
      } else {
        const arrayBuffer = await audioBlob.arrayBuffer();

        logger.debug(
          "Parakeet transcription starting",
          {
            audioFormat: audioBlob.type,
            audioSizeBytes: audioBlob.size,
            model,
          },
          "performance"
        );

        const transcriptionStart = performance.now();
        result = await window.electronAPI.transcribeLocalParakeet(arrayBuffer, { model });
        timings.transcriptionProcessingDurationMs = Math.round(
          performance.now() - transcriptionStart
        );

        logger.debug(
          "Parakeet transcription complete",
          {
            transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
            success: result.success,
          },
          "performance"
        );
      }

      if (result.success && result.text) {
        const rawText = result.text;
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local-parakeet");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return {
            success: true,
            text: text || result.text,
            rawText,
            source: "local-parakeet",
            timings,
            ...(result.warning ? { warning: result.warning } : {}),
          };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Parakeet transcription failed");
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const { allowOpenAIFallback, useLocalWhisper: isLocalMode } = getSettings();

      if (allowOpenAIFallback && isLocalMode) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          throw new Error(
            `Parakeet failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Parakeet failed: ${error.message}`);
      }
    }
  }

  async getAPIKey() {
    const s = getSettings();
    if (shouldSkipTranscriptionApiKey(s)) {
      return null;
    }

    const provider =
      s.cloudTranscriptionProvider || settingsDefaults.storeDefaults.cloudTranscriptionProvider;

    // Check cache (invalidate if provider changed)
    if (this.cachedApiKey !== null && this.cachedApiKeyProvider === provider) {
      return this.cachedApiKey;
    }

    let apiKey = null;

    if (provider === "custom") {
      // Prefer store value (user-entered via UI) over main process (.env)
      apiKey = s.customTranscriptionApiKey || "";
      if (!apiKey.trim()) {
        try {
          apiKey = await window.electronAPI.getCustomTranscriptionKey?.();
        } catch (err) {
          logger.debug(
            "Failed to get custom transcription key via IPC",
            { error: err?.message },
            "transcription"
          );
        }
      }
      apiKey = apiKey?.trim() || "";

      logger.debug(
        "Custom STT API key retrieval",
        {
          provider,
          hasKey: !!apiKey,
          keyLength: apiKey?.length || 0,
        },
        "transcription"
      );

      // For custom, we allow null/empty - the endpoint may not require auth
      if (!apiKey) {
        apiKey = null;
      }
    } else if (provider === "mistral") {
      // Prefer store value (user-entered via UI) over main process (.env)
      // to avoid stale keys in process.env after auth mode transitions
      apiKey = s.mistralApiKey;
      if (!isValidApiKey(apiKey, "mistral")) {
        apiKey = await window.electronAPI.getMistralKey?.();
      }
      if (!isValidApiKey(apiKey, "mistral")) {
        const err = new Error(
          "Mistral API key not found. Please set your API key in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    } else if (provider === "corti") {
      // Tokens are minted in the main process; only verify credentials exist here
      let clientId = s.cortiClientId;
      let clientSecret = s.cortiClientSecret;
      if (!clientId?.trim() || !clientSecret?.trim()) {
        [clientId, clientSecret] = await Promise.all([
          window.electronAPI.getCortiClientId?.(),
          window.electronAPI.getCortiClientSecret?.(),
        ]);
      }
      if (!clientId?.trim() || !clientSecret?.trim()) {
        const err = new Error(
          "Corti credentials not found. Please set your Client ID and Client Secret in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
      apiKey = null;
    } else if (provider === "tinfoil") {
      apiKey = s.tinfoilApiKey;
      if (!apiKey?.trim()) {
        apiKey = await window.electronAPI.getTinfoilKey?.();
      }
      if (!apiKey?.trim()) {
        const err = new Error(
          "Tinfoil API key not found. Please set your API key in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    } else if (provider === "groq") {
      // Prefer store value (user-entered via UI) over main process (.env)
      apiKey = s.groqApiKey;
      if (!isValidApiKey(apiKey, "groq")) {
        apiKey = await window.electronAPI.getGroqKey?.();
      }
      if (!isValidApiKey(apiKey, "groq")) {
        const err = new Error(
          "Groq API key not found. Please set your API key in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    } else if (provider === "xai") {
      apiKey = s.xaiApiKey;
      if (!isValidApiKey(apiKey, "xai")) {
        apiKey = await window.electronAPI.getXaiKey?.();
      }
      if (!isValidApiKey(apiKey, "xai")) {
        const err = new Error(
          "xAI API key not found. Please set your API key in the Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    } else {
      // Default to OpenAI
      // Prefer store value (user-entered via UI) over main process (.env)
      // to avoid stale keys in process.env after auth mode transitions
      apiKey = s.openaiApiKey;
      if (!isValidApiKey(apiKey, "openai")) {
        apiKey = await window.electronAPI.getOpenAIKey();
      }
      if (!isValidApiKey(apiKey, "openai")) {
        const err = new Error(
          "OpenAI API key not found. Please set your API key in the .env file or Control Panel."
        );
        err.code = "API_KEY_MISSING";
        throw err;
      }
    }

    this.cachedApiKey = apiKey;
    this.cachedApiKeyProvider = provider;
    return apiKey;
  }

  async processWithReasoningModel(text, model, agentName, config) {
    logger.logReasoning("CALLING_REASONING_SERVICE", {
      model,
      agentName,
      textLength: text.length,
      hasOverrides: !!config,
    });

    const startTime = Date.now();

    try {
      const result = await ReasoningService.processText(text, model, agentName, config);

      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_COMPLETE", {
        model,
        processingTimeMs: processingTime,
        resultLength: result.length,
        success: true,
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_ERROR", {
        model,
        processingTimeMs: processingTime,
        error: error.message,
        stack: error.stack,
      });

      throw error;
    }
  }

  async isReasoningAvailable() {
    if (typeof window === "undefined") {
      return false;
    }

    const s = getSettings();
    const useReasoning =
      !!s.useCleanupModel || dictationAgentReachable(s) || translationChainReachable(s);
    const now = Date.now();
    const cacheValid =
      this.reasoningAvailabilityCache &&
      now < this.reasoningAvailabilityCache.expiresAt &&
      this.cachedReasoningPreference === useReasoning;

    if (cacheValid) {
      return this.reasoningAvailabilityCache.value;
    }

    logger.logReasoning("REASONING_STORAGE_CHECK", {
      useReasoning,
    });

    if (!useReasoning) {
      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return false;
    }

    if (s.useCleanupModel && isCloudCleanupMode()) {
      this.reasoningAvailabilityCache = {
        value: true,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return true;
    }

    try {
      const isAvailable = await ReasoningService.isAvailable();

      logger.logReasoning("REASONING_AVAILABILITY", {
        isAvailable,
        reasoningEnabled: useReasoning,
        finalDecision: useReasoning && isAvailable,
      });

      this.reasoningAvailabilityCache = {
        value: isAvailable,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;

      return isAvailable;
    } catch (error) {
      logger.logReasoning("REASONING_AVAILABILITY_ERROR", {
        error: error.message,
        stack: error.stack,
      });

      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return false;
    }
  }

  // Cleanup-then-translate chain shared by batch, cloud, and streaming paths: Step 1
  // (optional cleanup) soft-fails to input; Step 2 translates unless source === target.
  async runTranslationChain({ text, settings, agentName, route, cleanup }) {
    const runCleanup = async (currentText) => {
      if (cleanup.mode === "cloudReason") {
        const reasonResult = await withSessionRefresh(async () => {
          const res = await window.electronAPI.cloudReason(currentText, {
            agentName,
            promptMode: "cleanup",
            customDictionary: getDictionaryHintWords(settings),
            customPrompt: this.getCustomPrompt(),
            language: this.getEffectiveSttLanguage(settings) || "auto",
            locale: settings.uiLanguage || "en",
            ...(cleanup.meta || {}),
          });
          if (!res.success) {
            const err = new Error(res.error || "Cloud reasoning failed");
            err.code = res.code;
            throw err;
          }
          return res;
        });
        return reasonResult.success && reasonResult.text ? reasonResult.text : null;
      }
      const cleanupModel = cleanup.model;
      if (cleanupModel) {
        return this.processWithReasoningModel(
          currentText,
          cleanupModel,
          agentName,
          route.cleanupConfig
        );
      }
      return null;
    };

    const runTranslate = async (currentText) =>
      this.processWithReasoningModel(currentText, route.model, agentName, route.config);

    try {
      return await executeTranslationChain({
        text,
        cleanupReachable: route.cleanupReachable,
        cleanupIsCloud: cleanup.mode === "cloudReason",
        runCleanup,
        runTranslate,
        shouldTranslate: shouldRunTranslateStep(
          settings.translationSourceLanguage,
          settings.translationTargetLanguage
        ),
        translateIsCloud: route.config?.provider === "openwhispr",
        onCleanupError: (cleanupError) => {
          const { level = "error", channel, extra } = cleanup.log || {};
          logger[level](
            "Cleanup step failed in translation chain, translating raw transcript",
            { ...(extra || {}), error: cleanupError.message },
            channel
          );
        },
        onEmptyTranslate: () => {
          const { channel } = cleanup.log || {};
          logger.warn("Translation step returned empty text, keeping previous text", {}, channel);
          this.notifyTranslationFallback("failed");
        },
      });
    } catch (translateError) {
      // Translate step threw: raw text is still pasted by the caller. Surface the failure.
      this.notifyTranslationFallback("failed");
      throw translateError;
    }
  }

  /**
   * Begin capturing the focused window, if the user has screen context on.
   *
   * Gated here rather than in the main process so a disabled setting means no
   * screenshot is ever taken — not a screenshot whose text is then discarded.
   */
  startScreenContextCapture() {
    // A new dictation invalidates the previous one's terms; see ensureScreenContext.
    this._screenContext = undefined;
    if (!getSettings().screenContextEnabled) return;
    window.electronAPI?.windowOcrStart?.();
  }

  /**
   * The capture for this dictation, collected at most once.
   *
   * Two callers need it now and they run at different times: the phrase list wants the
   * terms *before* the audio is sent, and the post-transcription matcher wants them
   * after. Collecting is destructive — it clears the pending capture so the next
   * dictation starts clean — so whoever asked second used to get nothing. The result is
   * cached for the dictation instead, and `undefined` distinguishes "not yet collected"
   * from a collected `null`.
   */
  async ensureScreenContext() {
    if (this._screenContext !== undefined) return this._screenContext;
    if (!getSettings().screenContextEnabled) {
      this._screenContext = null;
      return null;
    }
    this._screenContext = await this.collectScreenContext();
    return this._screenContext;
  }

  /**
   * Vocabulary to bias recognition with, best first.
   *
   * Two sources, both things the user has effectively vouched for: the custom
   * dictionary — which is also where auto-learned corrections are written — and the
   * terms read from the window they are dictating into. The dictionary goes first
   * because it is durable and deliberate, so it wins the budget when screen text is
   * plentiful.
   */
  // `limit` exists because providers disagree about how many terms they accept, and the
  // ceiling should be the provider's, not the lowest one's: Azure's phrase list and the
  // merge prompt want the conservative 200, while Gemini takes up to 1000 and there is
  // no reason to throw away 800 terms of the speaker's own vocabulary on its behalf.
  async getDictationVocabulary(limit = DICTATION_VOCABULARY_LIMIT) {
    const dictionary = this.getCustomDictionaryArray() ?? [];
    const capture = await this.ensureScreenContext();

    // Dictionary first: it is what the user deliberately curated, so it wins the cap
    // when a text-heavy window would otherwise fill it. Screen terms follow in the
    // frequency order extraction produced. Deduplicated case-insensitively because the
    // same term routinely arrives from both, and a duplicate spends the budget twice.
    const seen = new Set();
    const vocabulary = [];
    for (const term of [...dictionary, ...(capture?.terms ?? [])]) {
      if (typeof term !== "string") continue;
      const trimmed = term.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      vocabulary.push(trimmed);
      if (vocabulary.length >= limit) break;
    }
    return vocabulary;
  }

  /** Drop a capture whose dictation will never produce a transcript. */
  cancelScreenContextCapture() {
    window.electronAPI?.windowOcrCancel?.();
  }

  /**
   * Await the in-flight capture, but never for long.
   *
   * The capture starts when recording starts, so by the time there is a
   * transcript it has almost always finished and this returns immediately. The
   * budget is the ceiling on the exception — a wedged sidecar or a permission
   * dialog the user hasn't answered — because screen context is an enhancement
   * and must not hold up the paste. A capture abandoned here is dropped by the
   * manager rather than reused, so timing out cannot leak into the next
   * dictation.
   *
   * Timed and recorded like every other model call, under kind "screenContext" —
   * this is the number that actually answers whether OCR is adding latency:
   * median/p95 say how long a dictation typically sits here (should be ~0, since
   * the capture had the whole recording to finish), and the drop rate says how
   * often it hits this budget with nothing to show for it. Only the wait itself is
   * timed; whether `collect()` resolved with a real capture or a legitimate empty
   * one (disabled, no permission, nothing on screen) both count as "didn't have to
   * wait" the same way — that distinction belongs to applyScreenContext's own log,
   * not to a latency figure.
   */
  async collectScreenContext() {
    const collect = window.electronAPI?.windowOcrCollect;
    if (!collect) return null;

    const startedAt = performance.now();
    const expired = Symbol("expired");
    let timer;
    try {
      const outcome = await Promise.race([
        collect(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(expired), SCREEN_CONTEXT_COLLECT_BUDGET_MS);
        }),
      ]);
      if (outcome === expired) {
        this.recordModelLatency("screenContext", "screenContext", null, 0, "dropped");
        return null;
      }
      this.recordModelLatency(
        "screenContext",
        "screenContext",
        null,
        Math.round(performance.now() - startedAt),
        "ok"
      );
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Correct a transcript against the text on screen when the user started talking.
   *
   * Both tiers apply: an exact case-insensitive hit adopts the screen's casing,
   * and a phonetically equivalent near-miss of a distinctive on-screen term is
   * substituted.
   *
   * What gets recorded is the whole candidate vocabulary, not only the words that
   * changed — a run that corrected nothing is the common case, and seeing which
   * terms *were* on offer is the only way to tell "there was nothing to fix" apart
   * from "it read the wrong window" or "it never read anything". Rows are written
   * whenever a capture succeeded, for the same reason.
   *
   * Returns the original text unchanged on any failure — no context is a normal
   * outcome, not an error.
   */
  async applyScreenContext(text, source) {
    this._lastScreenContext = null;
    if (!text || !getSettings().screenContextEnabled) return text;

    try {
      // The capture arrives already reduced to vocabulary: the main process extracts
      // and filters it while the user is still speaking, so the raw screen text never
      // reaches this process. A null capture is a failure; an empty term list is a
      // window with nothing worth matching, which is a normal outcome.
      const capture = await this.ensureScreenContext();
      if (!capture) {
        await this.warnIfScreenContextBlocked();
        return text;
      }

      const terms = Array.isArray(capture.terms) ? capture.terms : [];
      const { applyScreenTermCorrections } = await import("../utils/screenTermMatcher.js");
      const { text: corrected, replacements } = applyScreenTermCorrections(text, terms);

      this._lastScreenContext = {
        window: capture.window || "",
        replacements,
        terms,
        termCount: capture.termCount ?? terms.length,
      };
      logger.info(
        replacements.length > 0
          ? "Screen context corrected the transcript"
          : "Screen context found nothing to correct",
        {
          source,
          window: capture.window,
          ocrChars: capture.ocrChars,
          termCount: terms.length,
          replacements,
        },
        "window-ocr"
      );
      return replacements.length > 0 ? corrected : text;
    } catch (error) {
      logger.debug(
        "Screen context failed, keeping the transcript",
        { error: error.message },
        "window-ocr"
      );
      return text;
    }
  }

  /**
   * Screen context is on but produced nothing. Say so if the reason is a missing
   * Screen Recording grant.
   *
   * A feature the user switched on that quietly does nothing is worse than one
   * that is off: there is no symptom to notice and nothing to act on. The grant is
   * checked rather than inferred from the sidecar's failure, so this fires only
   * when the machine could capture and simply is not allowed to — not when the
   * sidecar is missing, timed out, or found no window.
   *
   * Once per app run: the persistent version of this warning lives in Settings,
   * next to the toggle and in the permissions list. This one exists to connect it
   * to the dictation that just came back uncorrected.
   */
  async warnIfScreenContextBlocked() {
    if (this._screenContextPermissionWarned) return;

    const access = await window.electronAPI?.checkScreenRecordingPermission?.();
    if (!access?.supported || access.granted) return;

    this._screenContextPermissionWarned = true;
    logger.warn(
      "Screen context is on but Screen Recording is not granted",
      { status: access.status },
      "window-ocr"
    );
    this.onScreenContextBlocked?.({ status: access.status });
  }

  async processTranscription(text, source, { alreadyCleaned = false } = {}) {
    // Before cleanup, so the cleanup model reads correctly spelled names rather
    // than being asked to reason about a mishearing.
    const contextualized = await this.applyScreenContext(text, source);
    const normalizedText = typeof contextualized === "string" ? contextualized.trim() : "";

    if (!normalizedText) {
      logger.logReasoning("TRANSCRIPTION_EMPTY_SKIPPING_REASONING", {
        source,
        reason: "Empty text after normalization",
      });
      return normalizedText;
    }

    if (this.skipReasoning) {
      logger.logReasoning("REASONING_SKIPPED_AGENT_MODE", {
        source,
        reason: "skipReasoning is set (agent mode) — returning raw transcription",
      });
      return normalizedText;
    }

    logger.logReasoning("TRANSCRIPTION_RECEIVED", {
      source,
      textLength: normalizedText.length,
      textPreview: normalizedText.substring(0, 100) + (normalizedText.length > 100 ? "..." : ""),
      timestamp: new Date().toISOString(),
    });

    const cleanupModel = getEffectiveCleanupModel();
    const isCloud = isCloudCleanupMode();
    const settings = getSettings();
    const cleanupProvider =
      settings.cleanupProvider || settingsDefaults.storeDefaults.cleanupProvider;
    const cleanupReachable = !!settings.useCleanupModel && (!!cleanupModel || isCloud);
    const agentReachable = dictationAgentReachable(settings);
    const agentName =
      typeof window !== "undefined" && window.localStorage
        ? localStorage.getItem("agentName") || null
        : null;
    if (
      !cleanupReachable &&
      !agentReachable &&
      !(this.translationRequested && translationChainReachable(settings))
    ) {
      logger.logReasoning("REASONING_SKIPPED", {
        reason: "No cleanup or dictation-agent model available",
      });
      return normalizedText;
    }

    const useReasoning = await this.isReasoningAvailable();

    logger.logReasoning("REASONING_CHECK", {
      useReasoning,
      cleanupModel,
      cleanupProvider,
      agentName,
    });

    if (useReasoning) {
      let route;
      try {
        route = resolveReasoningRoute(
          normalizedText,
          settings,
          agentName,
          this.voiceAgentRequested,
          this.translationRequested,
          alreadyCleaned
        );
        if (this.translationRequested && route.kind !== "translation") {
          this.notifyTranslationFallback("unreachable");
        }
        if (route.kind === "skip") {
          if (alreadyCleaned) {
            logger.logReasoning("CLEANUP_SKIPPED_ALREADY_CLEANED", {
              source,
              reason: "Reconcile already cleaned this transcript",
            });
          }
          return normalizedText;
        }

        if (route.kind === "translation") {
          const { text: translatedText } = await this.runTranslationChain({
            text: normalizedText,
            settings,
            agentName,
            route,
            cleanup: {
              mode: "model",
              model: cleanupModel,
              log: { level: "warn", channel: "notes", extra: { source } },
            },
          });

          logger.logReasoning("REASONING_SUCCESS", {
            resultLength: translatedText.length,
            resultPreview:
              translatedText.substring(0, 100) + (translatedText.length > 100 ? "..." : ""),
            processingTime: new Date().toISOString(),
          });

          return translatedText;
        }

        const targetModel = route.kind === "agent" ? route.model : cleanupModel;
        const reasoningConfig = route.config;

        logger.logReasoning("SENDING_TO_REASONING", {
          preparedTextLength: normalizedText.length,
          model: targetModel,
          provider: route.config?.provider || cleanupProvider,
          path: route.kind,
          disableThinking: reasoningConfig?.disableThinking,
        });

        const result = await this.processWithReasoningModel(
          normalizedText,
          targetModel,
          agentName,
          reasoningConfig
        );

        logger.logReasoning("REASONING_SUCCESS", {
          resultLength: result.length,
          resultPreview: result.substring(0, 100) + (result.length > 100 ? "..." : ""),
          processingTime: new Date().toISOString(),
        });

        return result;
      } catch (error) {
        logger.logReasoning("REASONING_FAILED", {
          error: error.message,
          stack: error.stack,
          fallbackToCleanup: true,
        });
        logger.warn("Reasoning failed", { source, error: error.message }, "notes");
        if (route?.kind === "cleanup" && !isCleanupPermanentlyUnavailable(error)) {
          recordCleanupFailure();
        }
      }
    }

    logger.logReasoning("USING_STANDARD_CLEANUP", {
      reason: useReasoning ? "Reasoning failed" : "Reasoning not enabled",
    });

    return normalizedText;
  }

  shouldStreamTranscription(model, provider) {
    if (provider !== "openai") {
      return false;
    }
    const normalized = typeof model === "string" ? model.trim() : "";
    if (!normalized || normalized === "whisper-1") {
      return false;
    }
    if (normalized === "gpt-4o-transcribe" || normalized === "gpt-4o-transcribe-diarize") {
      return true;
    }
    return normalized.startsWith("gpt-4o-mini-transcribe");
  }

  async readTranscriptionStream(response) {
    const reader = response.body?.getReader();
    if (!reader) {
      logger.error("Streaming response body not available", {}, "transcription");
      throw new Error("Streaming response body not available");
    }

    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let collectedText = "";
    let finalText = null;
    let eventCount = 0;
    const eventTypes = {};

    const handleEvent = (payload) => {
      if (!payload || typeof payload !== "object") {
        return;
      }
      eventCount++;
      const eventType = payload.type || "unknown";
      eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;

      logger.debug(
        "Stream event received",
        {
          type: eventType,
          eventNumber: eventCount,
          payloadKeys: Object.keys(payload),
        },
        "transcription"
      );

      if (payload.type === "transcript.text.delta" && typeof payload.delta === "string") {
        collectedText += payload.delta;
        return;
      }
      if (payload.type === "transcript.text.segment" && typeof payload.text === "string") {
        collectedText += payload.text;
        return;
      }
      if (payload.type === "transcript.text.done" && typeof payload.text === "string") {
        finalText = payload.text;
        logger.debug(
          "Final transcript received",
          {
            textLength: payload.text.length,
          },
          "transcription"
        );
      }
    };

    logger.debug("Starting to read transcription stream", {}, "transcription");

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        logger.debug(
          "Stream reading complete",
          {
            eventCount,
            eventTypes,
            collectedTextLength: collectedText.length,
            hasFinalText: finalText !== null,
          },
          "transcription"
        );
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // Log first chunk to see format
      if (eventCount === 0 && chunk.length > 0) {
        logger.debug(
          "First stream chunk received",
          {
            chunkLength: chunk.length,
            chunkPreview: chunk.substring(0, 500),
          },
          "transcription"
        );
      }

      // Process complete lines from the buffer
      // Each SSE event is "data: <json>\n" followed by empty line
      const lines = buffer.split("\n");
      buffer = "";

      for (const line of lines) {
        const trimmedLine = line.trim();

        // Skip empty lines
        if (!trimmedLine) {
          continue;
        }

        // Extract data from "data: " prefix
        let data = "";
        if (trimmedLine.startsWith("data: ")) {
          data = trimmedLine.slice(6);
        } else if (trimmedLine.startsWith("data:")) {
          data = trimmedLine.slice(5).trim();
        } else {
          // Not a data line, could be leftover - keep in buffer
          buffer += line + "\n";
          continue;
        }

        // Handle [DONE] marker
        if (data === "[DONE]") {
          finalText = finalText ?? collectedText;
          continue;
        }

        // Try to parse JSON
        try {
          const parsed = JSON.parse(data);
          handleEvent(parsed);
        } catch (error) {
          // Incomplete JSON - put back in buffer for next iteration
          buffer += line + "\n";
        }
      }
    }

    const result = finalText ?? collectedText;
    logger.debug(
      "Stream processing complete",
      {
        resultLength: result.length,
        usedFinalText: finalText !== null,
        eventCount,
        eventTypes,
      },
      "transcription"
    );

    return result;
  }

  async processWithOpenWhisprCloud(audioBlob, metadata = {}) {
    if (!navigator.onLine) {
      const err = new Error("You're offline. Cloud transcription requires an internet connection.");
      err.code = "OFFLINE";
      err.messageKey = "hooks.audioRecording.errorDescriptions.offline";
      throw err;
    }

    const timings = {};
    const settings = getSettings();
    const language = getBaseLanguageCode(this.getEffectiveSttLanguage(settings));

    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioSizeBytes = audioBlob.size;
    const audioFormat = audioBlob.type;
    const opts = {};
    if (language) opts.language = language;
    const cleanupCloudMode =
      settings.cleanupCloudMode || settingsDefaults.storeDefaults.cleanupCloudMode;
    if (
      (settings.useCleanupModel && !this.skipReasoning && cleanupCloudMode === "openwhispr") ||
      (this.translationRequested &&
        !this.skipReasoning &&
        translationChainReachable(settings) &&
        isCloudTranslationMode())
    ) {
      opts.sendLogs = "false";
    }

    const dictionaryPrompt = this.getCustomDictionaryPrompt();
    if (dictionaryPrompt) opts.prompt = dictionaryPrompt;

    // Use withSessionRefresh to handle AUTH_EXPIRED automatically
    const transcriptionStart = performance.now();
    const result = await withSessionRefresh(async () => {
      const res = await window.electronAPI.cloudTranscribe(arrayBuffer, opts);
      if (!res.success) {
        const err = new Error(res.error || "Cloud transcription failed");
        err.code = res.code;
        throw err;
      }
      return res;
    });
    timings.transcriptionProcessingDurationMs = Math.round(performance.now() - transcriptionStart);

    const rawText = result.text;
    if (this.isDictionaryEcho(rawText)) {
      throw new Error("No audio detected");
    }
    let processedText = result.text;
    if (processedText && !this.skipReasoning) {
      const reasoningStart = performance.now();
      const agentName = localStorage.getItem("agentName") || null;
      const route = resolveReasoningRoute(
        processedText,
        settings,
        agentName,
        this.voiceAgentRequested,
        this.translationRequested
      );
      if (this.translationRequested && route.kind !== "translation") {
        this.notifyTranslationFallback("unreachable");
      }
      const cleanupCloudMode =
        settings.cleanupCloudMode || settingsDefaults.storeDefaults.cleanupCloudMode;

      try {
        if (route.kind === "agent") {
          const reasoned = await this.processWithReasoningModel(
            processedText,
            route.model,
            agentName,
            route.config
          );
          if (reasoned) processedText = reasoned;
        } else if (route.kind === "cleanup" && cleanupCloudMode === "openwhispr") {
          const reasonResult = await withSessionRefresh(async () => {
            const res = await window.electronAPI.cloudReason(processedText, {
              agentName,
              promptMode: "cleanup",
              customDictionary: getDictionaryHintWords(settings),
              customPrompt: this.getCustomPrompt(),
              language: this.getEffectiveSttLanguage(settings) || "auto",
              locale: settings.uiLanguage || "en",
              sttProvider: result.sttProvider,
              sttModel: result.sttModel,
              sttProcessingMs: result.sttProcessingMs,
              sttWordCount: result.sttWordCount,
              sttLanguage: result.sttLanguage,
              audioDurationMs: result.audioDurationMs,
              audioSizeBytes,
              audioFormat,
            });
            if (!res.success) {
              const err = new Error(res.error || "Cloud reasoning failed");
              err.code = res.code;
              throw err;
            }
            return res;
          });

          // Cloud cleanup can return success with empty text; keep the raw transcription instead of wiping it.
          if (reasonResult.success && reasonResult.text) {
            processedText = reasonResult.text;
          }
        } else if (route.kind === "cleanup") {
          const effectiveModel = getEffectiveCleanupModel();
          if (effectiveModel) {
            const reasoned = await this.processWithReasoningModel(
              processedText,
              effectiveModel,
              agentName,
              route.config
            );
            if (reasoned) processedText = reasoned;
          }
        } else if (route.kind === "translation") {
          const chainResult = await this.runTranslationChain({
            text: processedText,
            settings,
            agentName,
            route,
            cleanup:
              cleanupCloudMode === "openwhispr"
                ? {
                    mode: "cloudReason",
                    meta: {
                      sttProvider: result.sttProvider,
                      sttModel: result.sttModel,
                      sttProcessingMs: result.sttProcessingMs,
                      sttWordCount: result.sttWordCount,
                      sttLanguage: result.sttLanguage,
                      audioDurationMs: result.audioDurationMs,
                      audioSizeBytes,
                      audioFormat,
                    },
                    log: { level: "error", channel: "transcription" },
                  }
                : {
                    mode: "model",
                    model: getEffectiveCleanupModel(),
                    log: { level: "error", channel: "transcription" },
                  },
          });
          processedText = resolveTranslatedText(processedText, chainResult);
        }
      } catch (reasonError) {
        logger.error(
          "Cloud reasoning failed, using raw transcription",
          { error: reasonError.message },
          "transcription"
        );
        if (route.kind === "cleanup" && !isCleanupPermanentlyUnavailable(reasonError)) {
          recordCleanupFailure();
        }
      }
      timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);
    }

    return {
      success: true,
      text: processedText,
      rawText,
      source: "openwhispr",
      timings,
      limitReached: result.limitReached,
      wordsUsed: result.wordsUsed,
      wordsRemaining: result.wordsRemaining,
      clientTranscriptionId: result.clientTranscriptionId,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }

  getCustomDictionaryArray() {
    return getSettings().customDictionary;
  }

  getCustomPrompt() {
    return getSettings().customPrompts.cleanup || undefined;
  }

  /**
   * The speaker's terms, shaped for one provider.
   *
   * Every provider that biases on a term list goes through here, so there is one place
   * that builds the list and one place that knows each provider's ceiling. Before this,
   * four call sites assembled it themselves and they had already diverged: xAI and the
   * whisper-style providers were getting the custom dictionary only, while Azure, Gemini
   * and Soniox also got the terms read off screen — so the same dictation was biased
   * differently depending on which lane happened to run it.
   *
   * The generator is getDictationVocabulary, which is the single source and is cached per
   * dictation, so asking for several providers' shapes costs one capture.
   */
  async getProviderTerms(provider) {
    const shape = PROVIDER_TERM_SHAPES[provider] ?? PROVIDER_TERM_SHAPES.default;
    const terms = await this.getDictationVocabulary(shape.limit);
    return normalizeDictationTerms(terms, {
      limit: shape.limit,
      maxTermLength: shape.maxTermLength ?? Infinity,
    });
  }

  /**
   * The same terms as a comma-separated prompt, for the whisper-style providers that take
   * one instead of a list.
   *
   * The exact string sent is remembered, because isDictionaryEcho compares a transcript
   * against it to detect a recogniser echoing its own prompt back — and comparing against
   * a differently-built string would either miss an echo or reject real speech.
   */
  async getDictationPrompt(provider) {
    const shape = PROVIDER_TERM_SHAPES[provider] ?? PROVIDER_TERM_SHAPES.default;
    const terms = await this.getProviderTerms(provider);
    if (terms.length === 0) {
      this._lastDictationPrompt = null;
      return null;
    }
    const prompt = terms.join(", ").slice(0, shape.maxPromptChars ?? MAX_PROMPT_CHARS);
    this._lastDictationPrompt = prompt;
    return prompt;
  }

  async processWithOpenAIAPI(audioBlob, metadata = {}) {
    const timings = {};
    const apiSettings = getSettings();
    const language = getBaseLanguageCode(this.getEffectiveSttLanguage(apiSettings));
    const allowLocalFallback = apiSettings.allowLocalFallback;
    const fallbackModel =
      apiSettings.fallbackWhisperModel || settingsDefaults.storeDefaults.fallbackWhisperModel;

    try {
      const durationSeconds = metadata.durationSeconds ?? null;
      const model = this.getTranscriptionModel();
      const provider =
        apiSettings.cloudTranscriptionProvider ||
        settingsDefaults.storeDefaults.cloudTranscriptionProvider;

      logger.debug(
        "Transcription request starting",
        {
          provider,
          model,
          blobSize: audioBlob.size,
          blobType: audioBlob.type,
          durationSeconds,
          language,
        },
        "transcription"
      );

      const apiKey = await this.getAPIKey();
      const optimizedAudio = await this.prepareAudioForUpload(
        audioBlob,
        this.capturedPcmForUpload()
      );

      // Dispatch before endpoint resolution (which defaults to OpenAI and would leak
      // the key). Self-hosted wins, so a leftover "tinfoil" provider isn't diverted here.
      if (provider === "tinfoil" && !isSelfHostedTranscription(apiSettings)) {
        if (!window.electronAPI?.proxyTinfoilTranscription) {
          throw new Error("Tinfoil transcription is unavailable in this window");
        }
        const dictionaryPrompt = this.getCustomDictionaryPrompt();
        const apiCallStart = performance.now();
        const result = await window.electronAPI.proxyTinfoilTranscription({
          audioBuffer: await optimizedAudio.arrayBuffer(),
          language,
          prompt: dictionaryPrompt || undefined,
        });
        if (result?.error) {
          const err = new Error(result.error);
          if (result.code) err.code = result.code;
          if (result.messageKey) err.messageKey = result.messageKey;
          throw err;
        }
        const proxyText = result?.text;
        if (!proxyText?.trim()) {
          throw new Error("No text transcribed - Tinfoil response was empty");
        }
        if (this.isDictionaryEcho(proxyText)) {
          throw new Error("No audio detected");
        }
        timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
        const reasoningStart = performance.now();
        const text = await this.processTranscription(proxyText, "tinfoil");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        const source = (await this.isReasoningAvailable()) ? "tinfoil-reasoned" : "tinfoil";
        return { success: true, text, rawText: proxyText, source, timings };
      }

      const formData = new FormData();
      // Determine the correct file extension based on the blob type
      const mimeType = optimizedAudio.type || "audio/webm";
      const extension = mimeType.includes("webm")
        ? "webm"
        : mimeType.includes("ogg")
          ? "ogg"
          : mimeType.includes("mp4")
            ? "mp4"
            : mimeType.includes("mpeg")
              ? "mp3"
              : mimeType.includes("wav")
                ? "wav"
                : "webm";

      logger.debug(
        "FormData preparation",
        {
          mimeType,
          extension,
          optimizedSize: optimizedAudio.size,
          hasApiKey: !!apiKey,
        },
        "transcription"
      );

      formData.append("file", optimizedAudio, `audio.${extension}`);
      formData.append("model", model);

      if (language) {
        formData.append("language", language);
      }

      const endpoint = this.getTranscriptionEndpoint(model);

      // Groq rejects prompts > 896 chars (incl. when reached via "custom" provider).
      // 890 leaves margin for UTF-16 vs codepoint counting drift.
      const isGroqEndpoint = provider === "groq" || endpoint.includes("api.groq.com");
      const MAX_PROMPT_CHARS = isGroqEndpoint ? 890 : 900;
      let dictionaryPrompt = this.getCustomDictionaryPrompt();
      if (dictionaryPrompt) {
        if (dictionaryPrompt.length > MAX_PROMPT_CHARS) {
          const originalLength = dictionaryPrompt.length;
          const truncated = dictionaryPrompt.slice(0, MAX_PROMPT_CHARS);
          const lastComma = truncated.lastIndexOf(",");
          dictionaryPrompt = lastComma > 0 ? truncated.slice(0, lastComma) : truncated;
          logger.debug(
            "Custom dictionary prompt truncated",
            {
              originalLength,
              truncatedLength: dictionaryPrompt.length,
              maxChars: MAX_PROMPT_CHARS,
            },
            "transcription"
          );
        }
        formData.append("prompt", dictionaryPrompt);
      }

      const shouldStream = this.shouldStreamTranscription(model, provider);
      if (shouldStream) {
        formData.append("stream", "true");
      }

      const isCustomEndpoint =
        provider === "custom" ||
        (!endpoint.includes("api.openai.com") &&
          !endpoint.includes("api.groq.com") &&
          !endpoint.includes("api.x.ai") &&
          !endpoint.includes("api.mistral.ai"));

      const apiCallStart = performance.now();

      // Mistral uses x-api-key auth (not Bearer) and doesn't allow browser CORS — proxy through main process
      if (provider === "mistral" && window.electronAPI?.proxyMistralTranscription) {
        const audioBuffer = await optimizedAudio.arrayBuffer();
        const proxyData = { audioBuffer, model, language };

        if (dictionaryPrompt) {
          const tokens = dictionaryPrompt
            .split(",")
            .flatMap((entry) => entry.trim().split(/\s+/))
            .filter(Boolean)
            .slice(0, 100);
          if (tokens.length > 0) {
            proxyData.contextBias = tokens;
          }
        }

        const result = await window.electronAPI.proxyMistralTranscription(proxyData);
        const proxyText = result?.text;

        if (proxyText && proxyText.trim().length > 0) {
          if (this.isDictionaryEcho(proxyText)) {
            throw new Error("No audio detected");
          }
          timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
          const rawText = proxyText;
          const reasoningStart = performance.now();
          const text = await this.processTranscription(proxyText, "mistral");
          timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

          const source = (await this.isReasoningAvailable()) ? "mistral-reasoned" : "mistral";
          return { success: true, text, rawText, source, timings };
        }

        throw new Error("No text transcribed - Mistral response was empty");
      }

      // xAI STT has a non-OpenAI-compatible API — proxy through main process. See #910.
      if (provider === "xai" && window.electronAPI?.proxyXaiTranscription) {
        const audioBuffer = await optimizedAudio.arrayBuffer();
        const proxyData = {
          audioBuffer,
          mimeType: optimizedAudio.type || undefined,
          language: language !== "auto" ? language : undefined,
        };

        const keyterms = await this.getProviderTerms("xai");
        if (keyterms.length > 0) {
          proxyData.keyterms = keyterms;
        }

        const result = await window.electronAPI.proxyXaiTranscription(proxyData);
        const proxyText = result?.text;

        if (proxyText && proxyText.trim().length > 0) {
          if (this.isDictionaryEcho(proxyText)) {
            throw new Error("No audio detected");
          }
          timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
          const rawText = proxyText;
          const reasoningStart = performance.now();
          const text = await this.processTranscription(proxyText, "xai");
          timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

          const source = (await this.isReasoningAvailable()) ? "xai-reasoned" : "xai";
          return { success: true, text, rawText, source, timings };
        }

        throw new Error("No text transcribed - xAI response was empty");
      }

      // Gemini and Soniox are neither OpenAI-compatible nor proxied, so the
      // single-provider path needs them explicitly. Both reuse the exact request the
      // multi-transcription lanes make — transcribeOneShotWithProvider is the same code
      // both paths call, so a fix to either applies to both.
      if (provider === "gemini" || provider === "soniox") {
        const oneShotText = await this.transcribeOneShotWithProvider(optimizedAudio, provider, {
          language,
          model,
        });

        if (oneShotText && oneShotText.trim().length > 0) {
          if (this.isDictionaryEcho(oneShotText)) {
            throw new Error("No audio detected");
          }
          timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
          const rawText = oneShotText;
          const reasoningStart = performance.now();
          const text = await this.processTranscription(oneShotText, provider);
          timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

          const source = (await this.isReasoningAvailable()) ? `${provider}-reasoned` : provider;
          return { success: true, text, rawText, source, timings };
        }

        throw new Error(`No text transcribed - ${provider} response was empty`);
      }

      // Corti uses OAuth client credentials and an interaction-based REST flow — proxy through main process
      if (provider === "corti" && window.electronAPI?.proxyCortiTranscription) {
        const audioBuffer = await optimizedAudio.arrayBuffer();
        const proxyData = {
          audioBuffer,
          // Corti requires a concrete primaryLanguage; default to English when auto-detecting
          language: language || "en",
          environment:
            apiSettings.cortiEnvironment || settingsDefaults.storeDefaults.cortiEnvironment,
          tenant:
            (apiSettings.cortiTenant || "").trim() || settingsDefaults.storeDefaults.cortiTenant,
        };

        const result = await window.electronAPI.proxyCortiTranscription(proxyData);
        const proxyText = result?.text;

        if (proxyText && proxyText.trim().length > 0) {
          if (this.isDictionaryEcho(proxyText)) {
            throw new Error("No audio detected");
          }
          timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
          const rawText = proxyText;
          const reasoningStart = performance.now();
          const text = await this.processTranscription(proxyText, "corti");
          timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

          const source = (await this.isReasoningAvailable()) ? "corti-reasoned" : "corti";
          return { success: true, text, rawText, source, timings };
        }

        throw new Error("No text transcribed - Corti response was empty");
      }

      logger.debug(
        "Making transcription API request",
        {
          endpoint,
          shouldStream,
          model,
          provider,
          isCustomEndpoint,
          hasApiKey: !!apiKey,
        },
        "transcription"
      );

      // Build headers - only include Authorization if we have an API key
      const headers = {};
      if (apiKey) {
        // Azure OpenAI authenticates API keys via the `api-key` header, not a
        // Bearer token (which it reserves for Entra ID access tokens).
        if (isAzureOpenAIEndpoint(endpoint)) {
          headers["api-key"] = apiKey;
        } else {
          headers.Authorization = `Bearer ${apiKey}`;
        }
      }

      logger.debug(
        "STT request details",
        {
          endpoint,
          method: "POST",
          hasAuthHeader: !!apiKey,
          formDataFields: [
            "file",
            "model",
            language && language !== "auto" ? "language" : null,
            shouldStream ? "stream" : null,
          ].filter(Boolean),
        },
        "transcription"
      );

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: formData,
      });

      const responseContentType = response.headers.get("content-type") || "";

      logger.debug(
        "Transcription API response received",
        {
          status: response.status,
          statusText: response.statusText,
          contentType: responseContentType,
          ok: response.ok,
        },
        "transcription"
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          "Transcription API error response",
          {
            status: response.status,
            errorText,
          },
          "transcription"
        );
        const err = new Error(`API Error: ${response.status} ${errorText}`);
        if (response.status === 401) err.code = "INVALID_KEY";
        else if (response.status === 429) {
          // The user's own provider rate-limited the request — not an OpenWhispr plan limit
          err.code = "PROVIDER_RATE_LIMITED";
          err.messageKey = "hooks.audioRecording.errorDescriptions.providerRateLimited";
        } else if (response.status >= 500) err.code = "SERVER_ERROR";
        throw err;
      }

      let result;
      const contentType = responseContentType;

      if (shouldStream && contentType.includes("text/event-stream")) {
        logger.debug("Processing streaming response", { contentType }, "transcription");
        const streamedText = await this.readTranscriptionStream(response);
        result = { text: streamedText };
        logger.debug(
          "Streaming response parsed",
          {
            hasText: !!streamedText,
            textLength: streamedText?.length,
          },
          "transcription"
        );
      } else {
        const rawText = await response.text();
        logger.debug(
          "Raw API response body",
          {
            rawText: rawText.substring(0, 1000),
            fullLength: rawText.length,
          },
          "transcription"
        );

        try {
          result = JSON.parse(rawText);
        } catch (parseError) {
          logger.error(
            "Failed to parse JSON response",
            {
              parseError: parseError.message,
              rawText: rawText.substring(0, 500),
            },
            "transcription"
          );
          throw new Error(`Failed to parse API response: ${parseError.message}`);
        }

        logger.debug(
          "Parsed transcription result",
          {
            hasText: !!result.text,
            textLength: result.text?.length,
            resultKeys: Object.keys(result),
            fullResult: result,
          },
          "transcription"
        );
      }

      // Check for text - handle both empty string and missing field
      if (result.text && result.text.trim().length > 0) {
        if (this.isDictionaryEcho(result.text)) {
          throw new Error("No audio detected");
        }
        timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
        const rawText = result.text;

        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "openai");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        const source = (await this.isReasoningAvailable()) ? "openai-reasoned" : "openai";
        logger.debug(
          "Transcription successful",
          {
            originalLength: result.text.length,
            processedLength: text.length,
            source,
            transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
            reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
          },
          "transcription"
        );
        return { success: true, text, rawText, source, timings };
      } else {
        // Log at info level so it shows without debug mode
        logger.info(
          "Transcription returned empty - check audio input",
          {
            model,
            provider,
            endpoint,
            blobSize: audioBlob.size,
            blobType: audioBlob.type,
            mimeType,
            extension,
            resultText: result.text,
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
        logger.error(
          "No text in transcription result",
          {
            result,
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
        throw new Error(
          "No text transcribed - audio may be too short, silent, or in an unsupported format"
        );
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const isOpenAIMode = !getSettings().useLocalWhisper;

      if (allowLocalFallback && isOpenAIMode) {
        try {
          const arrayBuffer = await audioBlob.arrayBuffer();
          const options = { model: fallbackModel };
          if (language && language !== "auto") {
            options.language = language;
          }

          const result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);

          if (result.success && result.text) {
            const text = await this.processTranscription(result.text, "local-fallback");
            if (text) {
              return { success: true, text, source: "local-fallback" };
            }
          }
          throw error;
        } catch (fallbackError) {
          throw new Error(
            `OpenAI API failed: ${error.message}. Local fallback also failed: ${fallbackError.message}`
          );
        }
      }

      throw error;
    }
  }

  /**
   * One recording, one transcript, for the providers that are neither OpenAI-compatible
   * nor proxied through the main process.
   *
   * Called by both the multi-transcription fan-out and the single-provider path. They
   * had diverged: the fan-out had these providers and the single-provider path did not,
   * so choosing Gemini or Soniox as the only provider failed with "no transcription
   * endpoint configured" while the same provider worked fine as a lane.
   */
  async transcribeOneShotWithProvider(audioBlob, provider, { language, model } = {}) {
    const settings = getSettings();
    const resolvedModel = model || MULTI_TRANSCRIPTION_MODELS[provider];

    if (provider === "gemini") {
      const apiKey = settings.geminiApiKey;
      if (!apiKey) throw new Error("No gemini API key configured");

      // Transcription lives on the interactions endpoint, not generateContent — which
      // this model does advertise but answers with empty text. See geminiTranscribe.js.
      const body = buildGeminiBatchRequest({
        audioBase64: await blobToBase64(audioBlob),
        mimeType: audioBlob.type || "audio/wav",
        // Bare codes are accepted, so no locale mapping; "auto" omits the hint and
        // leaves the model's own detection in charge.
        language: language && language !== "auto" ? language : undefined,
        vocabulary: await this.getProviderTerms("gemini"),
        model: resolvedModel,
      });

      const response = await fetch(buildApiUrl(API_ENDPOINTS.GEMINI, GEMINI_INTERACTIONS_PATH), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Gemini transcription failed: ${response.status} ${detail.slice(0, 200)}`);
      }
      return parseGeminiBatchResponse(await response.json());
    }

    if (provider === "soniox") {
      const apiKey = settings.sonioxApiKey;
      if (!apiKey) throw new Error("No soniox API key configured");
      return this.transcribeWithSonioxAsync(audioBlob, {
        apiKey,
        model: resolvedModel,
        language,
      });
    }

    throw new Error(`Provider ${provider} has no one-shot transcription request`);
  }

  /**
   * Soniox async transcription: upload, create, poll, fetch, delete.
   *
   * Four requests where every other lane costs one, which is the price of this provider
   * being a job queue rather than a request/response endpoint. It sits behind the same
   * lane budget as the others, so a slow job is dropped by the fan-out rather than
   * holding up the paste.
   *
   * The upload is deleted afterwards, always. It is the user's dictation, and leaving it
   * on a third party's servers after it has been transcribed is not something this app
   * should do quietly — the deletes are fire-and-forget so a cleanup failure cannot cost
   * the transcript, but they are not optional.
   */
  async transcribeWithSonioxAsync(audioBlob, { apiKey, model, language }) {
    const call = async (method, path, { json, body } = {}) => {
      const response = await fetch(`${SONIOX_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(json ? { "Content-Type": "application/json" } : {}),
        },
        body: json ? JSON.stringify(json) : body,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Soniox ${method} ${path} failed: ${response.status} ${detail.slice(0, 160)}`
        );
      }
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    };

    const form = new FormData();
    const extension = (audioBlob.type || "").includes("wav") ? "wav" : "webm";
    form.append("file", audioBlob, `audio.${extension}`);
    const uploaded = await call("POST", SONIOX_PATHS.files, { body: form });
    const fileId = uploaded?.id;

    let transcriptionId = null;
    try {
      const created = await call("POST", SONIOX_PATHS.transcriptions, {
        json: buildSonioxAsyncRequest({
          fileId,
          model,
          language,
          vocabulary: await this.getProviderTerms("soniox"),
        }),
      });
      transcriptionId = created?.id;
      if (!transcriptionId) throw new Error("Soniox did not return a transcription id");

      // Bounded: the job is queued server-side and could stay pending indefinitely,
      // and this runs while the user is waiting for text to appear.
      const deadline = performance.now() + SONIOX_ASYNC_TIMEOUT_MS;
      let state = "pending";
      while (state === "pending") {
        const status = await call("GET", SONIOX_PATHS.transcription(transcriptionId));
        state = sonioxAsyncJobState(status);
        if (state === "completed") break;
        if (state === "error") {
          throw new Error(`Soniox transcription failed: ${status?.error_message || "unknown"}`);
        }
        if (performance.now() > deadline) {
          throw new Error(`Soniox transcription still pending after ${SONIOX_ASYNC_TIMEOUT_MS}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, SONIOX_ASYNC_POLL_MS));
      }

      const transcript = await call("GET", SONIOX_PATHS.transcript(transcriptionId));
      return parseSonioxAsyncTranscript(transcript);
    } finally {
      // In `finally` so a failed or timed-out job does not leave the recording behind
      // either. Swallowed because the transcript is what the caller needs, and a
      // cleanup error must not turn a successful dictation into a failed one.
      if (transcriptionId) {
        call("DELETE", SONIOX_PATHS.transcription(transcriptionId)).catch(() => {});
      }
      if (fileId) {
        call("DELETE", SONIOX_PATHS.file(fileId)).catch(() => {});
      }
    }
  }

  // Raw transcription from one provider: no cleanup, no reasoning, no fallback.
  // Dual mode needs two of these to compare, and processWithOpenAIAPI cannot
  // supply them — it applies reasoning inside each provider branch and returns a
  // finished result.
  //
  // Written alongside that method rather than extracted out of it on purpose.
  // processWithOpenAIAPI is the single-provider path for every provider, has no
  // test coverage (it needs browser APIs), and carries quirks that are easy to
  // break in a mechanical refactor: Azure's api-key header, Groq's prompt cap,
  // SSE streaming, dictionary-echo detection, the local-whisper fallback.
  // Duplicating the two request shapes dual mode needs is the cheaper risk.
  async transcribeRawWithProvider(audioBlob, provider, { language, model: requestedModel } = {}) {
    const settings = getSettings();
    const startedAt = performance.now();
    // The caller's per-side choice wins; the provider's default stands in when the
    // user has not picked one.
    const model = requestedModel?.trim() || MULTI_TRANSCRIPTION_MODELS[provider];
    if (!model) {
      throw new Error(`Provider ${provider} is not available for dual transcription`);
    }

    let text;
    if (provider === "xai") {
      if (!window.electronAPI?.proxyXaiTranscription) {
        throw new Error("xAI transcription is unavailable in this window");
      }
      // The xAI proxy takes no model: grok-stt is the only speech model xAI serves,
      // so the picker offers exactly one option and there is nothing to pass on.
      const keyterms = await this.getProviderTerms("xai");
      const result = await window.electronAPI.proxyXaiTranscription({
        audioBuffer: await audioBlob.arrayBuffer(),
        mimeType: audioBlob.type || undefined,
        language: language && language !== "auto" ? language : undefined,
        ...(keyterms.length > 0 ? { keyterms } : {}),
      });
      text = result?.text;
    } else if (provider === "azure-speech") {
      if (!window.electronAPI?.proxyAzureSpeechTranscription) {
        throw new Error("Azure Speech transcription is unavailable in this window");
      }
      // The only provider that can be biased before recognition rather than corrected
      // after it, which is why the phrases are assembled here and nowhere else.
      const result = await window.electronAPI.proxyAzureSpeechTranscription({
        audioBuffer: await audioBlob.arrayBuffer(),
        mimeType: audioBlob.type || undefined,
        // Azure rejects a bare "en"; an absent locale means the model's multilingual
        // mode, which is the right default when the user has not chosen a language.
        locale: language && language !== "auto" ? toAzureLocale(language) : undefined,
        phrases: await this.getProviderTerms("azure-speech"),
        model,
      });
      text = result?.text;
    } else if (provider === "gemini" || provider === "soniox") {
      text = await this.transcribeOneShotWithProvider(audioBlob, provider, { language, model });
    } else {
      // Table-driven rather than a chain of ternaries, so adding an OpenAI-compatible
      // transcription provider is one entry rather than an edit in three places.
      const compatible = OPENAI_COMPATIBLE_TRANSCRIPTION[provider];
      if (!compatible) {
        throw new Error(`Provider ${provider} has no transcription endpoint configured`);
      }
      const apiKey = settings[compatible.apiKeyField];
      if (!apiKey) {
        throw new Error(`No ${provider} API key configured`);
      }
      const endpoint = buildApiUrl(compatible.base, "/audio/transcriptions");

      const formData = new FormData();
      // Trimming re-encodes to WAV, so the filename must follow the blob rather
      // than assume the recorder's format.
      const extension = (audioBlob.type || "").includes("wav") ? "wav" : "webm";
      formData.append("file", audioBlob, `audio.${extension}`);
      formData.append("model", model);
      if (language && language !== "auto") formData.append("language", language);
      // Through the shared builder, so this lane is biased on the same terms as every
      // other — including the ones read off screen, which it used to miss. The per-
      // provider character cap lives in PROVIDER_TERM_SHAPES (Groq rejects over 896).
      const dictionaryPrompt = await this.getDictationPrompt(provider);
      if (dictionaryPrompt) {
        formData.append("prompt", dictionaryPrompt);
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `${provider} transcription failed: ${response.status} ${detail.slice(0, 200)}`
        );
      }
      text = (await response.json())?.text;
    }

    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) {
      throw new Error(`No text transcribed - ${provider} response was empty`);
    }
    // The dictionary prompt echoing back means silence, not speech.
    if (this.isDictionaryEcho(trimmed)) {
      throw new Error("No audio detected");
    }

    return {
      provider,
      model,
      text: trimmed,
      ms: Math.round(performance.now() - startedAt),
    };
  }

  // Dual transcription as a transcription source: raw text from two providers,
  // merged, then handed to the same cleanup and reasoning every other source
  // uses. Shaped to match processWithOpenAIAPI's return so callers don't branch.
  async processWithMultiTranscription(audioBlob, metadata = {}) {
    const timings = {};
    const settings = getSettings();
    const language = getBaseLanguageCode(this.getEffectiveSttLanguage(settings));

    const multi = await this.transcribeMulti(audioBlob, {
      language,
      // Drives the dynamic part of the slow-lane budget. Null when the recorder could not
      // report a length, which resolveMultiSecondWaitMs treats as "flat wait only".
      recordingSeconds: metadata.durationSeconds ?? null,
    });
    timings.transcriptionProcessingDurationMs = multi.transcribeMs;
    if (multi.reconcileMs != null) timings.reconcileDurationMs = multi.reconcileMs;
    timings.multi = {
      sides: multi.sides.map((side) => ({
        provider: side.provider,
        model: side.model,
        status: side.status,
        ms: side.ms,
      })),
      reconciled: multi.reconciled,
      reconcileMs: multi.reconcileMs ?? null,
      // A merge that ran out of time is not the same as one that was never needed, and
      // history says so rather than showing both as "no merge".
      reconcileDropped: !!multi.reconcileDropped,
      droppedProviders: multi.droppedProviders ?? [],
    };

    const answered = multi.sides.filter((side) => side.text);
    logger.info(
      "Multi transcription complete",
      {
        providers: multi.sides.map((side) => `${side.provider}:${side.status}`),
        reconciled: multi.reconciled,
        reconcileDropped: !!multi.reconcileDropped,
        agreed: !!multi.agreed,
        mergedFrom: multi.mergedFrom ?? answered.length,
        transcribeMs: multi.transcribeMs,
        reconcileMs: multi.reconcileMs,
        durationSeconds: metadata.durationSeconds ?? null,
      },
      "transcription"
    );

    const reasoningStart = performance.now();
    // A reconciled transcript has already been through the cleanup rules (the reconcile
    // prompt merges *and* cleans), so cleaning it again changes nothing and costs a
    // second LLM call in the paste path. Providers that agreed, or a single surviving
    // lane, leave reconciled false — those are raw and still get cleaned.
    const text = await this.processTranscription(multi.text, "multi", {
      alreadyCleaned: multi.reconciled,
    });
    timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

    // How far each lane sat from the merged result, scored only when the merge actually
    // combined more than one answer. When the merge was dropped or failed, the final text
    // *is* one lane's own output — scoring against it would hand that lane a flawless zero
    // and penalise the others for losing a coin toss. A single-answer dictation still runs
    // the merge, for the vocabulary and the cleanup, but there is nothing to compare: the
    // result is that one lane's text prepared, so its own rate would measure how much
    // tidying it needed rather than how much it misheard.
    const werReference = multi.reconciled && (multi.mergedFrom ?? 0) > 1 ? multi.text : null;

    // Every lane is recorded whatever became of it, but only an answer carries a timing:
    // a dropped lane's elapsed time is the wait budget and a failed one has none, so both
    // are counted for the rates instead of averaged into the median.
    for (const side of multi.sides) {
      this.recordModelLatency(
        "transcription",
        side.provider,
        side.model,
        side.ms,
        side.status === "ok" ? "ok" : side.status === "failed" ? "failed" : "dropped",
        werReference && side.text ? wordErrorRate(side.text, werReference) : null
      );
    }
    // No recordModelLatency("reconcile", ...) call here any more: with dual cleanup
    // mode, either merge lane can win, and both are recorded — win or lose — from
    // inside transcribeMulti itself, as soon as each one actually finishes. Recording
    // here again, keyed to slot A unconditionally, would both duplicate the winner's
    // sample and mislabel it when slot B was the one that actually answered.

    const source = (await this.isReasoningAvailable()) ? "multi-reasoned" : "multi";
    // Kept alongside the transcript so history can show what each provider actually
    // heard, which is the only place the disagreement the merge resolved is visible.
    const multiDetail = {
      sides: multi.sides.map((side) => ({
        provider: side.provider,
        model: side.model,
        status: side.status,
        ms: side.ms,
        text: side.text ?? null,
      })),
      reconciled: !!multi.reconciled,
      // How many answers the merge combined, and whether they already said the same
      // thing. Both used to be inferable from `reconciled` — it was false exactly when
      // the merge was skipped — and are not any more, now that it always runs.
      mergedFrom: multi.mergedFrom ?? null,
      agreed: !!multi.agreed,
      reconcileMs: multi.reconcileMs ?? null,
      // Which merge lane actually produced the pasted text — only meaningful with dual
      // cleanup mode on, where either slot could have won; null on the fallback paths,
      // where nothing was reconciled at all.
      reconciledBy: multi.reconciledBy ?? null,
      droppedProviders: multi.droppedProviders ?? [],
      mergedText: multi.text ?? null,
    };
    return { success: true, text, rawText: multi.text, source, timings, dual: multiDetail };
  }

  // Runs every configured provider over the same audio, in parallel, and has an LLM
  // combine whichever answers arrive in time.
  //
  // Returns raw text only — the caller still applies the normal cleanup and
  // reasoning, so this behaves like any other transcription source.
  //
  // Every degradation is silent and safe: if one provider fails the other's text
  // is used (better than today, where one outage means no transcript), if the two
  // agree the LLM is skipped, and if the reconcile call fails provider A's text
  // stands. Only both providers failing is an error.
  async transcribeMulti(audioBlob, { language, recordingSeconds = null } = {}) {
    const settings = getSettings();

    // Resolved centrally so the fan-out, the settings UI and the gate all agree on which
    // providers actually run — and so a stored slot plus a colliding default cannot send
    // the same provider twice while evicting another.
    const lanes = resolveMultiTranscriptionLanes(settings);

    // Trimmed once, before the fan-out: every provider gets the same shorter audio, and
    // the saving counts once per lane.
    const trimmedBlob = await this.prepareAudioForUpload(audioBlob, this.capturedPcmForUpload());

    const startedAt = performance.now();
    const settled = lanes.map(() => null);

    // All lanes upload and transcribe concurrently; nothing waits its turn.
    const track = (promise, index) =>
      promise.then(
        (value) => {
          settled[index] = { status: "fulfilled", value };
          return index;
        },
        (reason) => {
          settled[index] = { status: "rejected", reason };
          return index;
        }
      );
    const tracked = lanes.map((lane, index) =>
      track(
        this.transcribeRawWithProvider(trimmedBlob, lane.provider, {
          language,
          model: lane.model,
        }),
        index
      )
    );

    // The wait policy lives in multiTranscriptionRace, where it can be tested: the
    // budget starts at the first *successful* lane rather than the first to answer, so
    // a lane that fails fast is skipped over instead of starting the clock on lanes
    // that still might produce the only transcript.
    // Flat floor plus a share of the recording: the spread between the fastest and the
    // slowest lane grows with the amount of audio, so a fixed budget is simultaneously
    // too tight for a long dictation and needlessly loose for a short one. The measured
    // duration is preferred, with the length of what was actually uploaded as a fallback
    // for a recorder that reported nothing.
    const budgetSeconds = recordingSeconds ?? this._lastTrim?.originalSeconds ?? null;
    const budgetMs = resolveMultiSecondWaitMs(
      settings.dualTranscriptionSecondTimeoutMs,
      settings.dualTranscriptionSecondTimeoutPercent,
      budgetSeconds,
      settings.dualTranscriptionSecondTimeoutMaxMs
    );
    const { firstSuccessIndex, droppedIndexes } = await awaitLanesWithBudget(
      tracked,
      settled,
      budgetMs
    );
    const droppedProviders = droppedIndexes.map((index) => lanes[index].provider);

    if (droppedProviders.length > 0) {
      logger.info(
        "Multi transcription: dropped slow providers",
        {
          dropped: droppedProviders,
          kept: lanes.filter((_, i) => settled[i] !== null).map((lane) => lane.provider),
          budgetMs,
          // All three parts, so a drop can be read as "the floor was too low", "the
          // recording was too short for the percentage to matter", or "the cap bound
          // before the percentage did".
          budgetFlatMs: settings.dualTranscriptionSecondTimeoutMs,
          budgetPercent: settings.dualTranscriptionSecondTimeoutPercent,
          budgetMaxMs: settings.dualTranscriptionSecondTimeoutMaxMs,
          recordingSeconds: budgetSeconds,
          budgetStartedAfter: lanes[firstSuccessIndex]?.provider,
        },
        "transcription"
      );
    }

    // A lane that never settled was dropped; one that rejected failed outright. Both are
    // reported rather than omitted, and neither carries a timing worth averaging.
    const statusFor = (index) => {
      const result = settled[index];
      if (result?.status === "fulfilled") return "ok";
      if (result?.status === "rejected") return "failed";
      return "dropped";
    };

    const sides = lanes.map((lane, index) => {
      const result = settled[index];
      const ok = result?.status === "fulfilled";
      if (result?.status === "rejected") {
        logger.warn(
          "Multi transcription: provider failed",
          { provider: lane.provider, error: result.reason?.message },
          "transcription"
        );
      }
      return {
        slot: lane.slot,
        provider: lane.provider,
        model: lane.model,
        label: getMultiTranscriptionProvider(lane.provider)?.label || lane.provider,
        status: statusFor(index),
        text: ok ? result.value.text : null,
        ms: ok ? result.value.ms : null,
      };
    });

    const answered = sides.filter((side) => side.text && side.text.trim());
    if (answered.length === 0) {
      const firstRejection = settled.find((result) => result?.status === "rejected");
      throw firstRejection?.reason || new Error("Multi transcription produced no text");
    }

    const transcribeMs = Math.round(performance.now() - startedAt);
    const base = {
      sides,
      transcribeMs,
      // Kept for the stats readout and history rows written before slots existed.
      droppedProvider: droppedProviders[0] ?? null,
      droppedProviders,
    };

    // The merge runs on every dictation, including one that produced a single answer or
    // several identical ones. It used to be skipped there, on the grounds that there was
    // nothing to reconcile — which was true of reconciling and false of everything else
    // the same call does: it applies the speaker's vocabulary (their dictionary plus the
    // terms read off screen) and it cleans, punctuates and de-fillers the text. Skipping
    // it meant the most common dictations — the ones where the recognisers agreed —
    // pasted raw recogniser output while only the disagreeing ones got prepared.
    //
    // Agreement is still recorded, because it says something about the lanes even though
    // it no longer changes what happens.
    const agreed = answered.length > 1 && transcriptsAgree(...answered.map((side) => side.text));

    const reconcileStart = performance.now();
    const reconcileBudgetMs = Number.isFinite(settings.dualTranscriptionReconcileTimeoutMs)
      ? settings.dualTranscriptionReconcileTimeoutMs
      : DEFAULT_RECONCILE_TIMEOUT_MS;

    // The same list the recogniser was biased with, built once by the same method. Not
    // read off a field: that field is populated as a side effect of something else
    // asking, so the merge used to get the vocabulary only when an Azure lane happened
    // to have fetched it first, and nothing at all on an xAI/OpenAI/Groq setup. The
    // screen capture behind it is cached per dictation, so asking again is free.
    const vocabulary = await this.getDictationVocabulary();
    const versions = answered.map((side) => ({ text: side.text, provider: side.label }));
    const agentName = localStorage.getItem("agentName") || null;

    // The merge always races two models, first answer wins — not a mode the user can
    // turn off. Both lanes read from the same builder the Cleanup panel's test button
    // uses, so what a user tries a prompt against is a request this path actually
    // makes, for either slot.
    const reconcileLanes = [
      {
        provider: settings.dualTranscriptionReconcileProvider || DEFAULT_RECONCILE_PROVIDER,
        model: getEffectiveReconcileModel(),
      },
      {
        provider: settings.dualTranscriptionReconcileProviderB || DEFAULT_RECONCILE_PROVIDER_B,
        model: getEffectiveReconcileModelB(),
      },
    ];

    // Which answer stands if every merge lane fails or times out — computed before the
    // race so every path that gives up agrees on it.
    const fallback = chooseFallbackTranscript(answered);

    const reconcileSettled = reconcileLanes.map(() => null);
    const reconcileLaneStarts = reconcileLanes.map(() => performance.now());
    const trackReconcile = (promise, index) =>
      promise.then(
        (value) => {
          reconcileSettled[index] = { status: "fulfilled", value };
          return index;
        },
        (reason) => {
          reconcileSettled[index] = { status: "rejected", reason };
          return index;
        }
      );
    const reconcileTracked = reconcileLanes.map((lane, index) => {
      const request = buildReconcileRequest({
        versions,
        agentName,
        language,
        vocabulary,
        provider: lane.provider,
        model: lane.model,
      });
      return trackReconcile(
        ReasoningService.processText(request.input, request.model, null, request.options),
        index
      );
    });

    // Every lane gets its real elapsed time recorded whenever it actually finishes, not
    // just the one that wins the race below. This is deliberately different from how
    // transcription lanes are recorded (synchronously, right after the fan-out returns,
    // with a dropped lane's time being the wait budget rather than its real duration):
    // the whole point of racing two merge models is to learn how each one actually
    // performs, and a model that lost the race by finishing second still answered — its
    // stats should say so, even after the dictation this call belongs to has already
    // been pasted. Fire-and-forget, so a slow loser cannot hold up anything.
    reconcileLanes.forEach((lane, index) => {
      reconcileTracked[index].then(() => {
        const ms = Math.round(performance.now() - reconcileLaneStarts[index]);
        const ok = reconcileSettled[index]?.status === "fulfilled";
        this.recordModelLatency("reconcile", lane.provider, lane.model, ms, ok ? "ok" : "failed");
      });
    });

    // First lane to succeed wins, immediately — there is no reconciliation between the
    // two merge outputs to wait for, so a second answer is never used once the first
    // one lands. See raceLanesForFirstSuccess for why this is a different primitive
    // from the one the transcription fan-out above uses.
    const { winnerIndex: reconcileWinnerIndex, timedOut: reconcileTimedOut } =
      await raceLanesForFirstSuccess(reconcileTracked, reconcileSettled, reconcileBudgetMs);

    if (reconcileWinnerIndex === -1) {
      // Either every merge lane failed outright, or none answered within the budget —
      // either way there is no reconciled text, so the best single transcript stands.
      logger.warn(
        reconcileTimedOut
          ? "Multi transcription: merge race timed out, using the best single transcript"
          : "Multi transcription: every merge lane failed, using the best single transcript",
        {
          using: fallback.provider,
          lanes: reconcileLanes.map((lane) => `${lane.provider}/${lane.model}`),
          ...(reconcileTimedOut ? { budgetMs: reconcileBudgetMs } : {}),
        },
        "transcription"
      );
      return {
        ...base,
        text: fallback.text,
        reconciled: false,
        mergedFrom: answered.length,
        agreed,
      };
    }

    const winner = reconcileLanes[reconcileWinnerIndex];

    const trimmed =
      typeof reconcileSettled[reconcileWinnerIndex].value === "string"
        ? reconcileSettled[reconcileWinnerIndex].value.trim()
        : "";
    if (!trimmed) {
      // The winning lane technically succeeded but returned nothing usable — same
      // fallback as every lane failing, since there is no reconciled text to use.
      logger.warn(
        "Multi transcription: merge returned empty text, using the best single transcript",
        { using: fallback.provider, from: `${winner.provider}/${winner.model}` },
        "transcription"
      );
      return {
        ...base,
        text: fallback.text,
        reconciled: false,
        mergedFrom: answered.length,
        agreed,
      };
    }

    return {
      ...base,
      text: trimmed,
      reconciled: true,
      // How many answers went in: one means nothing was reconciled, only prepared,
      // which is what the WER column needs to know to avoid scoring a lane against a
      // cleaned copy of itself.
      mergedFrom: answered.length,
      agreed,
      reconcileMs: Math.round(performance.now() - reconcileStart),
      reconciledBy: { provider: winner.provider, model: winner.model },
    };
  }

  getTranscriptionModel() {
    try {
      const s = getSettings();
      const selfHostedModel = resolveSelfHostedTranscriptionModel(s);
      if (selfHostedModel) return selfHostedModel;
      const provider =
        s.cloudTranscriptionProvider || settingsDefaults.storeDefaults.cloudTranscriptionProvider;
      const trimmedModel = (s.cloudTranscriptionModel || "").trim();

      // For custom provider, use whatever model is set (or fallback to whisper-1)
      if (provider === "custom") {
        return trimmedModel || "whisper-1";
      }

      if (provider === "tinfoil") {
        return getBatchTranscriptionModel("tinfoil");
      }

      // Validate model matches provider to handle settings migration
      if (trimmedModel) {
        const isGroqModel = trimmedModel.startsWith("whisper-large-v3");
        const isOpenAIModel = trimmedModel.startsWith("gpt-4o") || trimmedModel === "whisper-1";
        const isMistralModel = trimmedModel.startsWith("voxtral-");
        const isCortiModel = trimmedModel.startsWith("corti-");

        if (provider === "groq" && isGroqModel) {
          return trimmedModel;
        }
        if (provider === "openai" && isOpenAIModel) {
          return trimmedModel;
        }
        if (provider === "mistral" && isMistralModel) {
          return trimmedModel;
        }
        if (provider === "corti" && isCortiModel) {
          return trimmedModel;
        }
        // Model doesn't match provider - fall through to default
      }

      // Return provider-appropriate default
      if (provider === "groq") return "whisper-large-v3-turbo";
      if (provider === "xai") return "grok-stt";
      if (provider === "mistral") return "voxtral-mini-latest";
      if (provider === "corti") return "corti-transcribe";
      return "gpt-4o-mini-transcribe";
    } catch (error) {
      return "gpt-4o-mini-transcribe";
    }
  }

  getTranscriptionEndpoint(deploymentName = "") {
    const s = getSettings();
    const currentProvider =
      s.cloudTranscriptionProvider || settingsDefaults.storeDefaults.cloudTranscriptionProvider;

    // Backstop against the OpenAI-default leak: Tinfoil goes through the main-process
    // proxy, never here — except self-hosted, which resolves its remote URL below.
    if (currentProvider === "tinfoil" && !isSelfHostedTranscription(s)) {
      throw new Error("Tinfoil transcription must go through the attested main-process proxy");
    }

    const currentBaseUrl = s.cloudTranscriptionBaseUrl || "";
    const transcriptionMode = s.transcriptionMode || "";
    const remoteUrl = (s.remoteTranscriptionUrl || "").trim();
    const deployment = (deploymentName || "").trim();

    const isSelfHosted = isSelfHostedTranscription(s);
    const isCustomEndpoint = isSelfHosted || currentProvider === "custom";

    // Never fall back to the cloud default for self-hosted — fail closed instead.
    if (isSelfHosted) {
      const normalizedRemote = normalizeBaseUrl(remoteUrl);
      if (!normalizedRemote || !isSecureEndpoint(normalizedRemote)) {
        throw new Error("Self-hosted transcription URL is invalid or unsupported");
      }
    }

    if (
      this.cachedTranscriptionEndpoint &&
      (this.cachedEndpointProvider !== currentProvider ||
        this.cachedEndpointDeployment !== deployment ||
        this.cachedEndpointBaseUrl !== currentBaseUrl ||
        this.cachedEndpointMode !== transcriptionMode ||
        this.cachedEndpointRemoteUrl !== remoteUrl)
    ) {
      logger.debug(
        "STT endpoint cache invalidated",
        {
          previousProvider: this.cachedEndpointProvider,
          newProvider: currentProvider,
          previousBaseUrl: this.cachedEndpointBaseUrl,
          newBaseUrl: currentBaseUrl,
          previousMode: this.cachedEndpointMode,
          newMode: transcriptionMode,
          previousRemoteUrl: this.cachedEndpointRemoteUrl,
          newRemoteUrl: remoteUrl,
        },
        "transcription"
      );
      this.cachedTranscriptionEndpoint = null;
    }

    if (this.cachedTranscriptionEndpoint) {
      return this.cachedTranscriptionEndpoint;
    }

    try {
      let base;
      if (isSelfHosted) {
        base = remoteUrl;
      } else if (currentProvider === "custom") {
        base = currentBaseUrl.trim() || API_ENDPOINTS.TRANSCRIPTION_BASE;
      } else if (currentProvider === "groq") {
        base = API_ENDPOINTS.GROQ_BASE;
      } else if (currentProvider === "xai") {
        base = API_ENDPOINTS.XAI_BASE;
      } else if (currentProvider === "mistral") {
        base = API_ENDPOINTS.MISTRAL_BASE;
      } else {
        // OpenAI or other standard providers
        base = API_ENDPOINTS.TRANSCRIPTION_BASE;
      }

      const normalizedBase = normalizeBaseUrl(base);

      logger.debug(
        "STT endpoint resolution",
        {
          provider: currentProvider,
          mode: transcriptionMode,
          isSelfHosted,
          isCustomEndpoint,
          rawBaseUrl: currentBaseUrl,
          remoteUrl,
          normalizedBase,
          defaultBase: API_ENDPOINTS.TRANSCRIPTION_BASE,
        },
        "transcription"
      );

      const cacheResult = (endpoint) => {
        this.cachedTranscriptionEndpoint = endpoint;
        this.cachedEndpointProvider = currentProvider;
        this.cachedEndpointBaseUrl = currentBaseUrl;
        this.cachedEndpointMode = transcriptionMode;
        this.cachedEndpointRemoteUrl = remoteUrl;
        this.cachedEndpointDeployment = deployment;

        logger.debug(
          "STT endpoint resolved",
          {
            endpoint,
            provider: currentProvider,
            isCustomEndpoint,
            usingDefault: endpoint === API_ENDPOINTS.TRANSCRIPTION,
          },
          "transcription"
        );

        return endpoint;
      };

      if (!normalizedBase) {
        logger.debug(
          "STT endpoint: using default (normalization failed)",
          { rawBase: base },
          "transcription"
        );
        return cacheResult(API_ENDPOINTS.TRANSCRIPTION);
      }

      // Only validate HTTPS for custom endpoints (known providers are already HTTPS)
      if (isCustomEndpoint && !isSecureEndpoint(normalizedBase)) {
        logger.warn(
          "STT endpoint: HTTPS required, falling back to default",
          { attemptedUrl: normalizedBase },
          "transcription"
        );
        return cacheResult(API_ENDPOINTS.TRANSCRIPTION);
      }

      let endpoint;
      if (isCustomEndpoint && isAzureOpenAIEndpoint(normalizedBase)) {
        // Azure OpenAI routes by deployment in the URL path and requires an
        // api-version query string — the plain {base}/audio/transcriptions
        // shape returns DeploymentNotFound. Build the deployment-style URL.
        // The api-version defaults to a transcribe-capable preview; a user can
        // override it by appending ?api-version=... to their endpoint URL.
        // Built from the raw base — normalization strips the /audio/transcriptions
        // suffix that marks a deployment the user pinned.
        const azureUrl = buildAzureTranscriptionUrl(base, deployment);
        if (azureUrl) {
          endpoint = azureUrl;
          logger.debug(
            "STT endpoint: built Azure deployment URL",
            { base, deployment, endpoint },
            "transcription"
          );
        } else {
          endpoint = buildApiUrl(normalizedBase, "/audio/transcriptions");
          logger.warn(
            "STT endpoint: Azure host detected but no deployment name; falling back to default path",
            { base: normalizedBase, endpoint },
            "transcription"
          );
        }
      } else if (/\/audio\/(transcriptions|translations)$/i.test(normalizedBase)) {
        endpoint = normalizedBase;
        logger.debug("STT endpoint: using full path from config", { endpoint }, "transcription");
      } else {
        endpoint = buildApiUrl(normalizedBase, "/audio/transcriptions");
        logger.debug(
          "STT endpoint: appending /audio/transcriptions to base",
          { base: normalizedBase, endpoint },
          "transcription"
        );
      }

      return cacheResult(endpoint);
    } catch (error) {
      logger.error(
        "STT endpoint resolution failed",
        { error: error.message, stack: error.stack },
        "transcription"
      );
      if (isSelfHosted) throw error;
      this.cachedTranscriptionEndpoint = API_ENDPOINTS.TRANSCRIPTION;
      this.cachedEndpointProvider = currentProvider;
      this.cachedEndpointBaseUrl = currentBaseUrl;
      this.cachedEndpointMode = transcriptionMode;
      this.cachedEndpointRemoteUrl = remoteUrl;
      return API_ENDPOINTS.TRANSCRIPTION;
    }
  }

  async safePaste(text, options = {}) {
    try {
      await window.electronAPI.pasteText(text, options);
      return true;
    } catch (error) {
      const message =
        error?.message ??
        (typeof error?.toString === "function" ? error.toString() : String(error));
      this.onError?.({
        title: "Paste Error",
        description: `Failed to paste text. Please check accessibility permissions. ${message}`,
      });
      return false;
    }
  }

  // Fire-and-forget: a latency sample is never worth failing or delaying a dictation
  // for, and the stats page treats a missing sample as simply not measured.
  recordModelLatency(kind, provider, model, ms, outcome = "ok", wer = null) {
    if (outcome === "ok" && (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0)) return;
    window.electronAPI
      ?.recordModelLatency?.({ kind, provider, model, ms, outcome, wer })
      .catch(() => {});
  }

  async saveTranscription(text, rawText = null, { clientTranscriptionId, dual = null } = {}) {
    // Read and clear before the retention check: whether or not this row is
    // stored, the corrections belong to the dictation that just ended and must
    // not be attributed to the next one.
    const screenContext = this._lastScreenContext;
    this._lastScreenContext = null;

    const screenContextJson =
      screenContext && screenContext.replacements.length > 0
        ? JSON.stringify({ replacements: screenContext.replacements })
        : null;

    if (!getSettings().dataRetentionEnabled) {
      logger.debug("Skipping transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return true;
    }

    try {
      const result = await window.electronAPI.saveTranscription(text, rawText, {
        clientTranscriptionId,
        routeKind: this.translationRequested ? "translation" : null,
        dualJson: dual ? JSON.stringify(dual) : null,
        screenContextJson,
      });
      if (result?.id) syncService.debouncedPush("transcription", result.id);

      // The OCR'd vocabulary goes to the main process, keyed by the row id that was
      // just minted — the only identifier this window and the control panel both
      // know. It is held in memory there and never written anywhere: it is the
      // contents of whatever window the user was looking at, which is not about
      // what they said. Only the replacements above are persisted, and those words
      // are already in the stored transcript, since the correction *is* the text
      // that got pasted.
      if (result?.id && screenContext) {
        window.electronAPI?.recordScreenContextTerms?.(result.id, {
          window: screenContext.window,
          terms: screenContext.terms,
          termCount: screenContext.termCount,
        });
      }

      // Save audio if we have a captured blob and the transcription was saved successfully
      if (result?.id && this.lastAudioBlob) {
        try {
          const arrayBuffer = await this.lastAudioBlob.arrayBuffer();
          await window.electronAPI.saveTranscriptionAudio(
            result.id,
            arrayBuffer,
            this.lastAudioMetadata
          );
        } catch (audioErr) {
          // Non-blocking: transcription is saved even if audio save fails
          logger.warn("Failed to save transcription audio", { error: audioErr.message }, "audio");
        }
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  async saveFailedTranscription(errorMessage, errorCode = null, metadata = {}) {
    if (!getSettings().dataRetentionEnabled) {
      logger.debug("Skipping failed transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return;
    }

    try {
      const result = await window.electronAPI.saveTranscription("", null, {
        status: "failed",
        errorMessage,
        errorCode,
        routeKind: this.translationRequested ? "translation" : null,
      });
      if (result?.id) syncService.debouncedPush("transcription", result.id);

      if (result?.id && this.lastAudioBlob) {
        try {
          const durationMs = metadata?.durationSeconds
            ? Math.round(metadata.durationSeconds * 1000)
            : null;
          const arrayBuffer = await this.lastAudioBlob.arrayBuffer();
          await window.electronAPI.saveTranscriptionAudio(result.id, arrayBuffer, {
            durationMs,
            provider: null,
            model: null,
          });
        } catch (audioErr) {
          logger.warn(
            "Failed to save audio for failed transcription",
            {
              error: audioErr.message,
            },
            "audio"
          );
        }
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
      }
    } catch (error) {
      logger.error(
        "Failed to save failed transcription record",
        {
          error: error.message,
        },
        "audio"
      );
    }
  }

  async saveDiscardedTranscription(blob, durationSeconds) {
    let savedId = null;
    try {
      const result = await window.electronAPI.saveTranscription("", null, {
        status: "discarded",
        routeKind: this.translationRequested ? "translation" : null,
      });
      if (!result?.id) return;
      savedId = result.id;

      if (blob) {
        const durationMs = durationSeconds ? Math.round(durationSeconds * 1000) : null;
        const arrayBuffer = await blob.arrayBuffer();
        await window.electronAPI.saveTranscriptionAudio(savedId, arrayBuffer, {
          durationMs,
          provider: null,
          model: null,
        });
      }

      syncService.debouncedPush("transcription", savedId);
    } catch (error) {
      logger.error(
        "Failed to save discarded transcription record",
        { error: error.message },
        "audio"
      );
      // A discarded row is only recoverable through its audio; if the audio save
      // failed, drop the dead row instead of leaving an empty unrecoverable entry. See #907.
      if (savedId != null) {
        try {
          await window.electronAPI.deleteTranscription(savedId);
        } catch (cleanupError) {
          logger.warn(
            "Failed to clean up discarded row after audio save failure",
            { error: cleanupError.message },
            "audio"
          );
        }
      }
    }
  }

  getState() {
    return {
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      isStreaming: this.isStreaming,
      isStreamingStartInProgress: this.streamingStartInProgress,
      micCaptureStatus: this.micCaptureStatus,
    };
  }

  shouldUseStreaming(isSignedInOverride) {
    const s = getSettings();
    if (s.useLocalWhisper) return false;

    // Dual transcription compares two finished transcripts, so it is batch-only.
    if (isMultiTranscriptionEnabled(s)) return false;

    // Self-hosted transcription is batch HTTP to the user's server, never cloud realtime WS.
    if (isSelfHostedTranscription(s)) return false;

    // Corti (BYOK) streams over its own WSS — independent of OpenWhispr Cloud.
    if (s.cloudTranscriptionProvider === "corti" && s.cloudTranscriptionMode === "byok") {
      return !!(s.cortiClientId && s.cortiClientSecret);
    }

    // xAI (BYOK) likewise streams over its own WSS with the key in a header,
    // unless the user picked batch — streaming costs twice as much per hour and
    // segments the transcript, so uploading the finished recording is a
    // legitimate preference.
    if (s.cloudTranscriptionProvider === "xai" && s.cloudTranscriptionMode === "byok") {
      if (s.xaiTranscriptionMode === "batch") return false;
      return !!s.xaiApiKey;
    }

    // Tinfoil realtime streams without an OpenWhispr account.
    if (s.cloudTranscriptionProvider === "tinfoil") {
      const provider = getTranscriptionProvider("tinfoil");
      const model = provider?.models.find((m) => m.id === s.cloudTranscriptionModel);
      return !!model?.streaming && !!s.tinfoilApiKey;
    }

    // For dictation/agent: respect sttConfig mode from the API — this allows
    // batch mode even for realtime-capable models (e.g. gpt-4o-mini-transcribe).
    if (this.context !== "notes" && this.sttConfig?.dictation?.mode === "batch") {
      return false;
    }

    if (REALTIME_MODELS.has(s.cloudTranscriptionModel)) {
      // Realtime WS is OpenAI-only — other providers fall through to HTTP.
      if (
        (s.cloudTranscriptionProvider ||
          settingsDefaults.storeDefaults.cloudTranscriptionProvider) !== "openai"
      )
        return false;
      if (s.cloudTranscriptionMode === "byok") return !!s.openaiApiKey;
      if (s.cloudTranscriptionMode === "openwhispr") return !!(isSignedInOverride ?? s.isSignedIn);
      return false;
    }

    if (s.cloudTranscriptionMode !== "openwhispr" || !(isSignedInOverride ?? s.isSignedIn)) {
      return false;
    }
    if (this.context === "notes") {
      return localStorage.getItem("notesStreamingPreference") === "streaming";
    }
    if (!this.sttConfig) return false;
    return this.sttConfig.dictation?.mode === "streaming";
  }

  async warmupStreamingConnection({ isSignedIn: isSignedInOverride } = {}) {
    if (!this.shouldUseStreaming(isSignedInOverride)) {
      logger.debug("Streaming warmup skipped - not in streaming mode", {}, "streaming");
      return false;
    }

    try {
      const provider = this.getStreamingProvider();
      const [, wsResult] = await Promise.all([
        this.cacheMicrophoneDeviceId(),
        withSessionRefresh(async () => {
          const {
            preferredLanguage: warmupLang,
            cloudTranscriptionModel,
            cloudTranscriptionMode,
            cortiEnvironment,
            cortiTenant,
          } = getSettings();
          const res = await provider.warmup({
            sampleRate: 16000,
            language: warmupLang && warmupLang !== "auto" ? warmupLang : undefined,
            keyterms: await this.getProviderTerms("xai"),
            model: cloudTranscriptionModel,
            mode: cloudTranscriptionMode === "byok" ? "byok" : "openwhispr",
            environment: cortiEnvironment,
            tenant: cortiTenant,
          });
          // Throw error to trigger retry if AUTH_EXPIRED
          if (!res.success && res.code) {
            const err = new Error(res.error || "Warmup failed");
            err.code = res.code;
            throw err;
          }
          return res;
        }),
      ]);

      if (wsResult.success) {
        // Pre-load AudioWorklet module so first recording is faster
        try {
          const audioContext = await this.getOrCreateAudioContext();
          if (!this.workletModuleLoaded) {
            await audioContext.audioWorklet.addModule(this.getWorkletBlobUrl());
            this.workletModuleLoaded = true;
            logger.debug("AudioWorklet module pre-loaded during warmup", {}, "streaming");
          }
        } catch (e) {
          logger.debug(
            "AudioWorklet pre-load failed (will retry on recording)",
            { error: e.message },
            "streaming"
          );
        }

        // Warm up the OS audio driver by briefly acquiring the mic, then releasing.
        // This forces macOS to initialize the audio subsystem so subsequent
        // getUserMedia calls resolve in ~100-200ms instead of ~500-1000ms.
        if (!this.micDriverWarmedUp) {
          try {
            const constraints = await this.getAudioConstraints();
            const tempStream = await navigator.mediaDevices.getUserMedia(constraints);
            tempStream.getTracks().forEach((track) => track.stop());
            this.micDriverWarmedUp = true;
            logger.debug("Microphone driver pre-warmed", {}, "streaming");
          } catch (e) {
            logger.debug(
              "Mic driver warmup failed (non-critical)",
              { error: e.message },
              "streaming"
            );
          }
        }

        logger.info(
          "Streaming connection warmed up",
          { alreadyWarm: wsResult.alreadyWarm, micCached: !!this.cachedMicDeviceId },
          "streaming"
        );
        return true;
      } else if (wsResult.code === "NO_API") {
        logger.debug("Streaming warmup skipped - API not configured", {}, "streaming");
        return false;
      } else {
        logger.warn("Streaming warmup failed", { error: wsResult.error }, "streaming");
        return false;
      }
    } catch (error) {
      logger.error("Streaming warmup error", { error: error.message }, "streaming");
      return false;
    }
  }

  async getOrCreateAudioContext() {
    if (this.persistentAudioContext && this.persistentAudioContext.state !== "closed") {
      if (this.persistentAudioContext.state === "suspended") {
        await this.persistentAudioContext.resume();
      }
      return this.persistentAudioContext;
    }
    this.persistentAudioContext = new AudioContext({ sampleRate: 16000 });
    this.workletModuleLoaded = false;
    return this.persistentAudioContext;
  }

  startStreamingFallbackRecorder(stream) {
    try {
      const chunks = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data?.size > 0) chunks.push(event.data);
      };
      recorder.start(RECORDING_TIMESLICE_MS);
      this.streamingFallbackRecorder = recorder;
      this.streamingFallbackChunks = chunks;
      return recorder;
    } catch (error) {
      logger.debug("Fallback recorder failed to start", { error: error.message }, "streaming");
      this.streamingFallbackRecorder = null;
      return null;
    }
  }

  async finishStreamingFallbackSegment() {
    const recorder = this.streamingFallbackRecorder;
    if (!recorder) return null;
    const chunks = this.streamingFallbackChunks;
    const collect = () => new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    let blob;
    if (recorder.state === "recording") {
      blob = await new Promise((resolve) => {
        recorder.onstop = () => resolve(collect());
        recorder.stop();
      });
    } else {
      // The recorder auto-stops when its track dies; its chunks still hold the
      // audio captured up to that point.
      blob = collect();
    }
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    if (blob?.size > 0) this._streamingFallbackSegments.push(blob);
    return blob;
  }

  async replaceStreamingMic(replacement, previous) {
    if (!this.streamingProcessor || !this.streamingAudioContext) {
      throw new Error("Streaming audio pipeline is unavailable");
    }
    const swap = (async () => {
      const nextSource = this.streamingAudioContext.createMediaStreamSource(replacement);
      nextSource.connect(this.streamingProcessor);
      this.streamingSource?.disconnect();
      this.streamingSource = nextSource;
      await this.finishStreamingFallbackSegment();
      if (!this.isStreaming || !this.isRecording) {
        throw new Error("Streaming stopped during microphone recovery");
      }
      this.startStreamingFallbackRecorder(replacement);
      previous?.getTracks().forEach((track) => track.stop());
      this.streamingStream = replacement;
    })();
    // Expose the swap so stopStreamingRecording can wait for it instead of
    // racing it (losing the newest fallback segment / orphaning a recorder).
    this._streamingMicSwapPromise = swap.catch(() => {});
    try {
      await swap;
    } finally {
      this._streamingMicSwapPromise = null;
    }
  }

  async startStreamingRecording(forceDefaultMic = false) {
    try {
      if (this.streamingStartInProgress) {
        return false;
      }
      this.streamingStartInProgress = true;

      if (this.isRecording || this.isStreaming || this.isProcessing) {
        this.streamingStartInProgress = false;
        return false;
      }

      // Same as the batch path: start OCR before the mic, so it overlaps speech.
      this.startScreenContextCapture();

      this.stopRequestedDuringStreamingStart = false;

      const t0 = performance.now();
      const constraints = await this.getAudioConstraints(forceDefaultMic);
      const tConstraints = performance.now();

      // 1. Get mic stream (can take 10-15s on cold macOS mic driver)
      const rawStream = await navigator.mediaDevices.getUserMedia(constraints);
      const tMedia = performance.now();

      const stream = await this.acquireHealthyMicStream(rawStream, constraints);

      const audioTrack = stream.getAudioTracks()[0];

      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Streaming recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            usedCachedId: !!this.cachedMicDeviceId,
            muted: audioTrack.muted,
            readyState: audioTrack.readyState,
          },
          "audio"
        );
      }

      // Start fallback recorder in case streaming produces no results.
      this._streamingFallbackSegments = [];
      this.startStreamingFallbackRecorder(stream);

      // 2. Set up audio pipeline so frames flow the instant WebSocket is ready.
      //    Frames sent before the connection is open are buffered (bounded) by
      //    sendAudio(), not dropped.
      const audioContext = await this.getOrCreateAudioContext();
      this.streamingAudioContext = audioContext;
      this.streamingSource = audioContext.createMediaStreamSource(stream);
      this.streamingStream = stream;

      if (!this.workletModuleLoaded) {
        await audioContext.audioWorklet.addModule(this.getWorkletBlobUrl());
        this.workletModuleLoaded = true;
      }

      this.streamingProcessor = new AudioWorkletNode(audioContext, "pcm-streaming-processor");
      const provider = this.getStreamingProvider();

      this.streamingProcessor.port.onmessage = (event) => {
        if (!this.isStreaming) return;
        provider.send(event.data);
      };

      this.isStreaming = true;
      this.streamingSource.connect(this.streamingProcessor);

      const tPipeline = performance.now();

      // 3. Register IPC event listeners BEFORE connecting, so no transcript
      //    events are lost during the connect handshake.
      this.streamingFinalText = "";
      this.streamingPartialText = "";
      this.streamingTextResolve = null;
      this.streamingTextDebounce = null;

      const partialCleanup = provider.onPartial((text) => {
        this.streamingPartialText = text;
        this.onPartialTranscript?.(text);
      });

      const finalCleanup = provider.onFinal((text) => {
        // text = accumulated final text from streaming provider.
        // Extract just the new segment (delta from previous accumulated final).
        const prevLen = this.streamingFinalText.length;
        this.streamingFinalText = text;
        this.streamingPartialText = "";
        const newSegment = text.slice(prevLen);
        if (newSegment) {
          this.onStreamingCommit?.(newSegment);
        }
      });

      const errorCleanup = provider.onError((error) => {
        logger.error("Streaming provider error", { error }, "streaming");
        this.onError?.({
          title: "Streaming Error",
          description: error,
        });
        if (this.isStreaming) {
          logger.warn("Connection lost during streaming, auto-stopping", {}, "streaming");
          this.stopStreamingRecording().catch((e) => {
            logger.error(
              "Auto-stop after connection loss failed",
              { error: e.message },
              "streaming"
            );
          });
        }
      });

      const sessionEndCleanup = provider.onSessionEnd((data) => {
        logger.debug("Streaming session ended", data, "streaming");
        if (data.text) {
          this.streamingFinalText = data.text;
        }
      });

      this.streamingCleanupFns = [partialCleanup, finalCleanup, errorCleanup, sessionEndCleanup];
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this.onStateChange?.({ isRecording: true, isProcessing: false, isStreaming: true });
      await this.beginMicRecovery(stream);

      // 4. Connect WebSocket — audio is already flowing from the pipeline above,
      //    so Deepgram receives data immediately (no idle timeout).
      const result = await withSessionRefresh(async () => {
        const streamingSettings = getSettings();
        const {
          cloudTranscriptionModel,
          cloudTranscriptionMode,
          cortiEnvironment,
          cortiTenant,
          useLocalWhisper,
        } = streamingSettings;
        const sttLanguage = this.getEffectiveSttLanguage(streamingSettings);

        // Fetched unconditionally: the OCR capture is already in flight and resolves in
        // one or two milliseconds, so there is nothing to save by asking only for the
        // providers that bias on it. Each provider trims to its own ceiling.

        const res = await provider.start({
          sampleRate: 16000,
          language: sttLanguage && sttLanguage !== "auto" ? sttLanguage : undefined,
          keyterms: await this.getProviderTerms("xai"),
          vocabulary: await this.getProviderTerms(streamingSettings.cloudTranscriptionProvider),
          model: cloudTranscriptionModel,
          mode: cloudTranscriptionMode === "byok" ? "byok" : "openwhispr",
          environment: cortiEnvironment,
          tenant: cortiTenant,
        });

        if (!res.success) {
          if (res.code === "NO_API") {
            return { needsFallback: true };
          }
          if (res.code === "NETWORK_ERROR" && useLocalWhisper) {
            this.onError?.({
              code: "NETWORK_ERROR",
              title: "streaming.errors.cloudUnreachable.title",
              description: "Cloud unreachable — using local engine for this recording.",
              messageKey: "streaming.errors.cloudUnreachable.fallback",
            });
            return { needsFallback: true };
          }
          const err = new Error(res.error || "Failed to start streaming session");
          err.code = res.code;
          err.messageKey = res.messageKey;
          err.networkCode = res.networkCode;
          throw err;
        }
        return res;
      });
      const tWs = performance.now();

      if (result.needsFallback) {
        this.isRecording = false;
        this.recordingStartTime = null;
        this.stopRequestedDuringStreamingStart = false;
        await this.cleanupStreaming();
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
        this.streamingStartInProgress = false;
        logger.debug(
          "Streaming API not configured, falling back to regular recording",
          {},
          "streaming"
        );
        return this.startRecording();
      }

      logger.info(
        "Streaming start timing",
        {
          constraintsMs: Math.round(tConstraints - t0),
          getUserMediaMs: Math.round(tMedia - tConstraints),
          pipelineMs: Math.round(tPipeline - tMedia),
          wsConnectMs: Math.round(tWs - tPipeline),
          totalMs: Math.round(tWs - t0),
          usedWarmConnection: result.usedWarmConnection,
          micDriverWarmedUp: !!this.micDriverWarmedUp,
        },
        "streaming"
      );

      this.streamingStartInProgress = false;
      if (this.stopRequestedDuringStreamingStart) {
        this.stopRequestedDuringStreamingStart = false;
        logger.debug("Applying deferred streaming stop requested during startup", {}, "streaming");
        return this.stopStreamingRecording();
      }
      return true;
    } catch (error) {
      const stopRequested = this.stopRequestedDuringStreamingStart;
      this.streamingStartInProgress = false;
      this.stopRequestedDuringStreamingStart = false;

      if (isStaleDeviceError(error) && !forceDefaultMic && !stopRequested) {
        // Pinned mic is gone (Chromium rotates IDs / device unplugged). Retry once on the default mic. See #900.
        logger.warn(
          "Pinned microphone unavailable, retrying streaming on default mic",
          {},
          "streaming"
        );
        this.cachedMicDeviceId = null;
        await this.cleanupStreaming();
        this.isRecording = false;
        this.recordingStartTime = null;
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
        return this.startStreamingRecording(true);
      }

      logger.error("Failed to start streaming recording", { error: error.message }, "streaming");

      let errorTitle = "Streaming Error";
      let errorDescription = `Failed to start streaming: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (error.code === "AUTH_EXPIRED" || error.code === "AUTH_REQUIRED") {
        errorTitle = "Sign-in Required";
        errorDescription =
          "Your OpenWhispr Cloud session is unavailable. Please sign in again from Settings.";
      } else if (error.code === "NETWORK_ERROR") {
        errorTitle = "streaming.errors.cloudUnreachable.title";
        errorDescription = error.messageKey || "streaming.errors.cloudUnreachable.generic";
      } else if (error.name === "MicUnusableError") {
        errorTitle = "Microphone Muted";
        errorDescription =
          "Your microphones stayed muted and produced no audio. Please check your sound input settings and try again.";
      }

      this.onError?.({
        code: error.code,
        messageKey: error.messageKey,
        title: errorTitle,
        description: errorDescription,
      });

      await this.cleanupStreaming();
      this.isRecording = false;
      this.recordingStartTime = null;
      this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
      return false;
    }
  }

  async stopStreamingRecording() {
    if (this.streamingStartInProgress) {
      this.stopRequestedDuringStreamingStart = true;
      logger.debug("Streaming stop requested while start is in progress", {}, "streaming");
      return true;
    }

    if (!this.isStreaming) return false;
    this.micRecovery.stop();
    // Let an in-flight mic swap settle so its fallback segment isn't lost and
    // its replacement recorder doesn't outlive this stop.
    if (this._streamingMicSwapPromise) await this._streamingMicSwapPromise;

    const durationSeconds = this.recordingStartTime
      ? (Date.now() - this.recordingStartTime) / 1000
      : null;

    const t0 = performance.now();
    let finalText = this.streamingFinalText || "";

    // 1. Update UI immediately
    this.isRecording = false;
    this.recordingStartTime = null;
    this.onStateChange?.({ isRecording: false, isProcessing: true, isStreaming: false });

    // 2. Stop the processor — it flushes its remaining buffer on "stop".
    //    Keep isStreaming TRUE so the port.onmessage handler forwards the flush to WebSocket.
    if (this.streamingProcessor) {
      try {
        this.streamingProcessor.port.postMessage("stop");
        this.streamingProcessor.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingProcessor = null;
    }
    if (this.streamingSource) {
      try {
        this.streamingSource.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingSource = null;
    }
    this.streamingAudioContext = null;

    // Stop fallback recorder before stopping media tracks
    let fallbackBlob = null;
    await this.finishStreamingFallbackSegment();
    try {
      fallbackBlob = await this.mergeRecordedSegments(this._streamingFallbackSegments);
    } catch (error) {
      logger.warn(
        "Failed to merge streaming fallback audio",
        { error: error.message },
        "streaming"
      );
      fallbackBlob = this.getLargestRecordedSegment(this._streamingFallbackSegments);
    }
    if (fallbackBlob) {
      this.lastAudioBlob = fallbackBlob;
    }
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];
    this._streamingFallbackSegments = [];

    if (this.streamingStream) {
      this.streamingStream.getTracks().forEach((track) => track.stop());
      this.streamingStream = null;
    }
    const tAudioCleanup = performance.now();

    // 3. Wait for flushed buffer to travel: port -> main thread -> IPC -> WebSocket -> server.
    //    Then mark streaming done so no further audio is forwarded.
    await new Promise((resolve) => setTimeout(resolve, 120));
    this.isStreaming = false;

    // 4. Finalize tells the provider to process any buffered audio and send final results.
    //    Wait briefly so the server sends back the finalized transcript before disconnect.
    const provider = this.getStreamingProvider();
    provider.finalize?.();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const tForceEndpoint = performance.now();

    const stopResult = await provider.stop().catch((e) => {
      logger.debug("Streaming disconnect error", { error: e.message }, "streaming");
      return { success: false };
    });
    const tTerminate = performance.now();

    finalText = this.streamingFinalText || "";

    if (!finalText && this.streamingPartialText) {
      finalText = this.streamingPartialText;
      logger.debug("Using partial text as fallback", { textLength: finalText.length }, "streaming");
    }

    if (!finalText && stopResult?.text) {
      finalText = stopResult.text;
      logger.debug(
        "Using disconnect result text as fallback",
        { textLength: finalText.length },
        "streaming"
      );
    }

    this.cleanupStreamingListeners();

    logger.info(
      "Streaming stop timing",
      {
        durationSeconds,
        audioCleanupMs: Math.round(tAudioCleanup - t0),
        flushWaitMs: Math.round(tForceEndpoint - tAudioCleanup),
        terminateRoundTripMs: Math.round(tTerminate - tForceEndpoint),
        totalStopMs: Math.round(tTerminate - t0),
        textLength: finalText.length,
      },
      "streaming"
    );

    // Streaming has its own reasoning block below, so screen context is applied
    // here rather than in processTranscription. Before that block for the same
    // reason as the batch path: cleanup should read the corrected names.
    finalText = await this.applyScreenContext(finalText, "streaming");

    const stSettings = getSettings();
    const streamingSttModel = stopResult?.model || "nova-3";
    const streamingSttProcessingMs = Math.round(tTerminate - t0);
    const streamingAudioBytesSent = stopResult?.audioBytesSent || 0;
    const streamingSttLanguage =
      getBaseLanguageCode(this.getEffectiveSttLanguage(stSettings)) || undefined;
    const streamingSttWordCount = finalText ? finalText.split(/\s+/).filter(Boolean).length : 0;

    let usedCloudReasoning = false;
    if (finalText && !this.skipReasoning) {
      const reasoningStart = performance.now();
      const agentName = localStorage.getItem("agentName") || null;
      const route = resolveReasoningRoute(
        finalText,
        stSettings,
        agentName,
        this.voiceAgentRequested,
        this.translationRequested
      );
      if (this.translationRequested && route.kind !== "translation") {
        this.notifyTranslationFallback("unreachable");
      }
      const cleanupCloudMode =
        stSettings.cleanupCloudMode || settingsDefaults.storeDefaults.cleanupCloudMode;

      try {
        if (route.kind === "agent") {
          const reasoned = await this.processWithReasoningModel(
            finalText,
            route.model,
            agentName,
            route.config
          );
          if (reasoned) finalText = reasoned;
          logger.info(
            "Streaming dictation-agent complete",
            { reasoningDurationMs: Math.round(performance.now() - reasoningStart) },
            "streaming"
          );
        } else if (route.kind === "cleanup" && cleanupCloudMode === "openwhispr") {
          const reasonResult = await withSessionRefresh(async () => {
            const res = await window.electronAPI.cloudReason(finalText, {
              agentName,
              promptMode: "cleanup",
              customDictionary: getDictionaryHintWords(stSettings),
              customPrompt: this.getCustomPrompt(),
              language: this.getEffectiveSttLanguage(stSettings) || "auto",
              locale: stSettings.uiLanguage || "en",
              sttProvider: this.getStreamingProviderName(),
              sttModel: streamingSttModel,
              sttProcessingMs: streamingSttProcessingMs,
              sttWordCount: streamingSttWordCount,
              sttLanguage: streamingSttLanguage,
              audioDurationMs: durationSeconds ? Math.round(durationSeconds * 1000) : undefined,
              audioSizeBytes: streamingAudioBytesSent || undefined,
              audioFormat: "linear16",
            });
            if (!res.success) {
              const err = new Error(res.error || "Cloud reasoning failed");
              err.code = res.code;
              throw err;
            }
            return res;
          });

          if (reasonResult.success && reasonResult.text) {
            finalText = reasonResult.text;
          }
          usedCloudReasoning = true;

          logger.info(
            "Streaming reasoning complete",
            {
              reasoningDurationMs: Math.round(performance.now() - reasoningStart),
              model: reasonResult.model,
            },
            "streaming"
          );
        } else if (route.kind === "cleanup") {
          const effectiveModel = getEffectiveCleanupModel();
          if (effectiveModel) {
            const reasoned = await this.processWithReasoningModel(
              finalText,
              effectiveModel,
              agentName,
              route.config
            );
            if (reasoned) finalText = reasoned;
            logger.info(
              "Streaming BYOK reasoning complete",
              { reasoningDurationMs: Math.round(performance.now() - reasoningStart) },
              "streaming"
            );
          }
        } else if (route.kind === "translation") {
          const chainResult = await this.runTranslationChain({
            text: finalText,
            settings: stSettings,
            agentName,
            route,
            cleanup:
              cleanupCloudMode === "openwhispr"
                ? {
                    mode: "cloudReason",
                    meta: {
                      sttProvider: this.getStreamingProviderName(),
                      sttModel: streamingSttModel,
                      sttProcessingMs: streamingSttProcessingMs,
                      sttWordCount: streamingSttWordCount,
                      sttLanguage: streamingSttLanguage,
                      audioDurationMs: durationSeconds
                        ? Math.round(durationSeconds * 1000)
                        : undefined,
                      audioSizeBytes: streamingAudioBytesSent || undefined,
                      audioFormat: "linear16",
                    },
                    log: { level: "error", channel: "streaming" },
                  }
                : {
                    mode: "model",
                    model: getEffectiveCleanupModel(),
                    log: { level: "error", channel: "streaming" },
                  },
          });
          finalText = resolveTranslatedText(finalText, chainResult);
          usedCloudReasoning = chainResult.usedCloudReasoning || usedCloudReasoning;
        }
      } catch (reasonError) {
        logger.error(
          "Streaming reasoning failed, using raw text",
          { error: reasonError.message },
          "streaming"
        );
        if (route.kind === "cleanup" && !isCleanupPermanentlyUnavailable(reasonError)) {
          recordCleanupFailure();
        }
      }
    }

    // If streaming produced no text, fall back to batch — routed so BYOK audio
    // and cloud audio never cross over (see resolveStreamingFallbackTarget).
    let usedBatchFallback = false;
    let batchWarning = null;
    if (!finalText && durationSeconds > 2 && fallbackBlob?.size > 0) {
      const target = resolveStreamingFallbackTarget(getSettings());
      if (target === "skip") {
        logger.warn(
          "Skipping batch fallback: OpenWhispr Cloud session signed out",
          {},
          "streaming"
        );
      } else {
        logger.info(
          "Streaming produced no text, falling back to batch transcription",
          { durationSeconds, blobSize: fallbackBlob.size, target },
          "streaming"
        );
        try {
          // Cloud records usage server-side via /api/transcribe; BYOK has no metering.
          const batchResult =
            target === "cloud"
              ? await this.processWithOpenWhisprCloud(fallbackBlob, { durationSeconds })
              : await this.processWithOpenAIAPI(fallbackBlob, { durationSeconds });
          if (batchResult?.text) {
            finalText = batchResult.text;
            usedBatchFallback = true;
            batchWarning = batchResult.warning || null;
            logger.info("Batch fallback succeeded", { textLength: finalText.length }, "streaming");
          }
        } catch (fallbackErr) {
          logger.error("Batch fallback failed", { error: fallbackErr.message }, "streaming");
        }
      }
    }

    if (finalText) {
      const tBeforePaste = performance.now();
      const clientTotalMs = Math.round(tBeforePaste - t0);
      this.lastAudioMetadata = {
        durationMs: durationSeconds
          ? Math.round(durationSeconds * 1000)
          : Math.round(tBeforePaste - t0),
        provider: `${this.getStreamingProviderName()}-streaming`,
        model: streamingSttModel || null,
      };
      this.onTranscriptionComplete?.({
        success: true,
        text: finalText,
        rawText: finalText,
        source: `${this.getStreamingProviderName()}-streaming`,
        ...(batchWarning ? { warning: batchWarning } : {}),
      });

      if (!usedBatchFallback) {
        (async () => {
          try {
            await withSessionRefresh(async () => {
              const res = await window.electronAPI.cloudStreamingUsage(
                finalText,
                durationSeconds ?? 0,
                {
                  sendLogs: !usedCloudReasoning,
                  sttProvider: this.getStreamingProviderName(),
                  sttModel: streamingSttModel,
                  sttProcessingMs: streamingSttProcessingMs,
                  sttLanguage: streamingSttLanguage,
                  audioSizeBytes: streamingAudioBytesSent || undefined,
                  audioFormat: "linear16",
                  clientTotalMs,
                }
              );
              if (!res.success) {
                const err = new Error(res.error || "Streaming usage recording failed");
                err.code = res.code;
                throw err;
              }
            });
          } catch (err) {
            logger.error("Failed to report streaming usage", { error: err.message }, "streaming");
          }
          window.dispatchEvent(new Event("usage-changed"));
        })();
      } else {
        window.dispatchEvent(new Event("usage-changed"));
      }

      logger.info(
        "Streaming total processing",
        {
          totalProcessingMs: Math.round(tBeforePaste - t0),
          hasReasoning: stSettings.useCleanupModel || stSettings.useDictationAgent,
        },
        "streaming"
      );
    } else {
      // Silence: still fire callback to dismiss the preview and show the no-audio toast.
      this.onTranscriptionComplete?.({ success: true, text: "" });
    }

    this.isProcessing = false;
    this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });

    if (this.shouldUseStreaming()) {
      this.warmupStreamingConnection().catch((e) => {
        logger.debug("Background re-warm failed", { error: e.message }, "streaming");
      });
    }

    return true;
  }

  shouldShowPreviewCleanupState() {
    const settings = getSettings();
    return (
      (!!settings.useCleanupModel ||
        !!settings.useDictationAgent ||
        (this.translationRequested && !!settings.useDictationTranslation)) &&
      !this.skipReasoning
    );
  }

  async cleanupPreview(options = {}) {
    const { dismiss = false, showCleanup = false } = options;

    // Claim the session's nodes synchronously so a recording started during the
    // flush await can never have its fresh nodes torn down by this cleanup.
    const processor = this._previewProcessor;
    const source = this._previewSource;
    const audioContext = this._previewAudioContext;
    this._previewProcessor = null;
    this._previewSource = null;
    this._previewAudioContext = null;

    let flushed = true;
    if (processor) {
      // The worklet posts all PCM before "flushed", and the PCM sends share the
      // renderer->main pipe with the stop invoke (FIFO), so the final chunk precedes finish.
      let resolveFlush;
      const flushSentinel = new Promise((resolve) => {
        resolveFlush = () => resolve(true);
      });
      let watchdogTimer;
      const watchdogFired = new Promise((resolve) => {
        watchdogTimer = setTimeout(() => resolve(false), PREVIEW_FLUSH_WATCHDOG_MS);
      });
      this._previewFlushResolve = resolveFlush;
      processor.port.postMessage("stop");
      flushed = await Promise.race([flushSentinel, watchdogFired]);
      clearTimeout(watchdogTimer);
      if (this._previewFlushResolve === resolveFlush) this._previewFlushResolve = null;
      processor.disconnect();
    }
    source?.disconnect();
    audioContext?.close().catch(() => {});
    if (dismiss) {
      window.electronAPI?.dismissDictationPreview?.();
      return null;
    }
    return (await window.electronAPI?.stopDictationPreview?.({ showCleanup, flushed })) || null;
  }

  cleanupStreamingAudio() {
    if (this.streamingFallbackRecorder?.state === "recording") {
      try {
        this.streamingFallbackRecorder.stop();
      } catch {}
    }
    this.streamingFallbackRecorder = null;
    this.streamingFallbackChunks = [];

    if (this.streamingProcessor) {
      try {
        this.streamingProcessor.port.postMessage("stop");
        this.streamingProcessor.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingProcessor = null;
    }

    if (this.streamingSource) {
      try {
        this.streamingSource.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingSource = null;
    }

    this.streamingAudioContext = null;

    if (this.streamingStream) {
      this.streamingStream.getTracks().forEach((track) => track.stop());
      this.streamingStream = null;
    }

    this.isStreaming = false;
  }

  cleanupStreamingListeners() {
    for (const cleanup of this.streamingCleanupFns) {
      try {
        cleanup?.();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    this.streamingCleanupFns = [];
    this.streamingFinalText = "";
    this.streamingPartialText = "";
    this.streamingTextResolve = null;
    clearTimeout(this.streamingTextDebounce);
    this.streamingTextDebounce = null;
  }

  async cleanupStreaming() {
    this.micRecovery.stop();
    this.cleanupStreamingAudio();
    this.cleanupStreamingListeners();
  }

  cleanup() {
    this.micRecovery.stop();
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    if (this.isStreaming) {
      this.cleanupStreaming();
    }
    if (this.mediaRecorder?.state === "recording") {
      this.stopRecording();
    }
    if (this.persistentAudioContext && this.persistentAudioContext.state !== "closed") {
      this.persistentAudioContext.close().catch(() => {});
      this.persistentAudioContext = null;
      this.workletModuleLoaded = false;
    }
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    try {
      this.getStreamingProvider().stop?.();
    } catch (e) {
      // Ignore errors during cleanup (page may be unloading)
    }
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.onPartialTranscript = null;
    this.onStreamingCommit = null;
    if (this._onApiKeyChanged) {
      window.removeEventListener("api-key-changed", this._onApiKeyChanged);
    }
    if (this._onDeviceChange) {
      navigator.mediaDevices?.removeEventListener?.("devicechange", this._onDeviceChange);
    }
  }
}

export { resolveReasoningRoute };
export default AudioManager;
