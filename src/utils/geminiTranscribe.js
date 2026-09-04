// Wire format for Gemini 3.5 Transcribe, both variants.
//
// Two different API surfaces, which is why they live together here rather than being
// inlined at their call sites — the request shapes are similar enough to be confused
// for each other and the differences are not guessable:
//
//   batch  gemini-3.5-transcribe        POST /v1beta/interactions
//          transcription config goes at generation_config.transcription_config
//
//   live   gemini-3.5-transcribe-live   WSS .../BidiGenerateContent
//          the same config goes at setup.input_audio_transcription
//
// Every field name below was confirmed against the live API on 2026-08-28, not read off
// a blog post. That matters because the endpoint rejects unknown fields, and the two
// surfaces disagree about where the config lives: `generation_config.transcription_config`
// is a 400 on the live socket, and `input_audio_transcription` is a 400 on the batch
// endpoint. camelCase is also rejected — the API answers `Unknown parameter
// 'languageCodes'. Did you mean 'language_codes'?` — so these keys are snake_case
// deliberately and must stay that way.
//
// Also confirmed, and worth knowing before changing any of it:
//   - `generateContent` is listed for the batch model but returns empty text. The
//     interactions endpoint is the one that transcribes.
//   - Audio can be sent inline as base64, so there is no upload-then-reference round
//     trip for a dictation that is already in memory.
//   - There are no separate switches for formatting or normalization. `mode: "smart"`
//     is that feature: it strips fillers, self-corrections and false starts, and
//     formats lists and dates. The alternative is `"verbatim"`.

const { normalizeDictationTerms } = require("./dictationTerms");

const GEMINI_TRANSCRIBE_BATCH_MODEL = "gemini-3.5-transcribe";
const GEMINI_TRANSCRIBE_LIVE_MODEL = "gemini-3.5-transcribe-live";

const GEMINI_INTERACTIONS_PATH = "/interactions";
const GEMINI_LIVE_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// Server-enforced: 1000 entries returns 400 "custom_vocabulary cannot contain more than
// 1000 entries." Google's own guidance is that around 100 terms gives the best results,
// so this is a hard ceiling rather than a target to fill.
const GEMINI_VOCABULARY_LIMIT = 1000;

// Smart by default. The whole point of this model over a plain recogniser is that it
// removes fillers and formats the result, and doing that here means a dictation reads
// like written text before the merge model ever sees it.
const DEFAULT_TRANSCRIPTION_MODE = "smart";

// PCM16 mono at 16 kHz, which is already what the recorder produces for upload.
const GEMINI_LIVE_AUDIO_MIME = "audio/pcm;rate=16000";

/**
 * The transcription config both variants share.
 *
 * @param {object} opts
 * @param {string} [opts.language] - App language code ("en", "zh"). Bare codes are
 *   accepted; there is no locale mapping to do. "auto" or empty omits the hint entirely,
 *   which leaves the model's own detection across 85+ languages in charge.
 * @param {string[]} [opts.vocabulary] - Custom dictionary plus on-screen terms.
 * @param {string} [opts.mode] - "smart" | "verbatim"
 */
function buildTranscriptionConfig({
  language,
  vocabulary,
  mode = DEFAULT_TRANSCRIPTION_MODE,
} = {}) {
  const config = { mode };

  // Only when actually known: a wrong hint is worse than none, and "auto" is the app's
  // way of saying it does not know.
  if (language && language !== "auto") {
    config.language_codes = [language];
  }

  const terms = normalizeVocabulary(vocabulary);
  if (terms.length > 0) {
    config.custom_vocabulary = terms;
  }
  return config;
}

/**
 * Clean a vocabulary list into something the API will accept.
 *
 * Shared with every other provider that takes a term list — see dictationTerms.js for
 * the rules and why they are stated in one place.
 */
function normalizeVocabulary(vocabulary) {
  return normalizeDictationTerms(vocabulary, { limit: GEMINI_VOCABULARY_LIMIT });
}

/**
 * Body for a batch transcription.
 *
 * @param {object} opts
 * @param {string} opts.audioBase64 - The recording, base64-encoded.
 * @param {string} [opts.mimeType]
 */
function buildBatchRequest({
  audioBase64,
  mimeType = "audio/wav",
  language,
  vocabulary,
  mode,
  model = GEMINI_TRANSCRIBE_BATCH_MODEL,
} = {}) {
  return {
    model,
    input: [{ type: "audio", data: audioBase64, mime_type: mimeType }],
    generation_config: {
      transcription_config: buildTranscriptionConfig({ language, vocabulary, mode }),
    },
  };
}

/**
 * The transcript out of a batch response.
 *
 * Shape is `steps[]`, each with a `type`; the transcript is in the one marked
 * `model_output`, whose `content[]` entries carry `text`. Returns "" rather than
 * throwing on a response that carries no transcript, so a caller treats an empty
 * result the same way it treats any other provider returning nothing.
 */
function parseBatchResponse(json) {
  const steps = Array.isArray(json?.steps) ? json.steps : [];
  const parts = [];
  for (const step of steps) {
    if (step?.type !== "model_output") continue;
    const content = Array.isArray(step.content) ? step.content : [];
    for (const entry of content) {
      if (typeof entry?.text === "string" && entry.text) parts.push(entry.text);
    }
  }
  return parts.join(" ").trim();
}

/** The websocket URL, key in the query string as the Live API requires. */
function buildLiveUrl(apiKey) {
  return `${GEMINI_LIVE_WS_URL}?key=${encodeURIComponent(apiKey || "")}`;
}

/**
 * The first message on the socket. Nothing may be sent before `setupComplete` comes
 * back, and the config goes at `input_audio_transcription` here — not under
 * generation_config, which the socket rejects outright.
 */
function buildLiveSetup({ language, vocabulary, mode, model = GEMINI_TRANSCRIBE_LIVE_MODEL } = {}) {
  return {
    setup: {
      // The live socket wants the fully qualified name, unlike the batch endpoint.
      model: model.startsWith("models/") ? model : `models/${model}`,
      input_audio_transcription: buildTranscriptionConfig({ language, vocabulary, mode }),
    },
  };
}

/** One chunk of microphone audio. */
function buildLiveAudioChunk(base64Pcm) {
  return { realtime_input: { audio: { mime_type: GEMINI_LIVE_AUDIO_MIME, data: base64Pcm } } };
}

/** Tells the server the utterance is over so it can emit its final transcript. */
function buildLiveAudioStreamEnd() {
  return { realtime_input: { audio_stream_end: true } };
}

/**
 * Classify one server message.
 *
 * `interimInputTranscription` is a partial and arrives repeatedly, each one a fuller
 * version of the same utterance rather than a delta to append — so a consumer replaces
 * its preview text rather than concatenating. `inputTranscription` is the final.
 *
 * @returns {{kind: "setup"|"partial"|"final"|"done"|"other", text?: string}}
 */
function parseLiveMessage(message) {
  if (!message || typeof message !== "object") return { kind: "other" };
  if (message.setupComplete !== undefined) return { kind: "setup" };

  const server = message.serverContent;
  if (server && typeof server === "object") {
    const interim = server.interimInputTranscription?.text;
    if (typeof interim === "string" && interim) return { kind: "partial", text: interim };

    const final = server.inputTranscription?.text;
    if (typeof final === "string" && final) return { kind: "final", text: final };

    if (server.generationComplete) return { kind: "done" };
  }
  return { kind: "other" };
}

module.exports = {
  GEMINI_TRANSCRIBE_BATCH_MODEL,
  GEMINI_TRANSCRIBE_LIVE_MODEL,
  GEMINI_INTERACTIONS_PATH,
  GEMINI_LIVE_WS_URL,
  GEMINI_LIVE_AUDIO_MIME,
  GEMINI_VOCABULARY_LIMIT,
  DEFAULT_TRANSCRIPTION_MODE,
  buildTranscriptionConfig,
  normalizeVocabulary,
  buildBatchRequest,
  parseBatchResponse,
  buildLiveUrl,
  buildLiveSetup,
  buildLiveAudioChunk,
  buildLiveAudioStreamEnd,
  parseLiveMessage,
};
