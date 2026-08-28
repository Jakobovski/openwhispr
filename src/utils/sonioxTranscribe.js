// Wire format for Soniox speech-to-text, both variants.
//
//   realtime  stt-rt-v5     WSS wss://stt-rt.soniox.com/transcribe-websocket
//   async     stt-async-v5  REST, four calls: upload, create, poll, fetch
//
// Confirmed against the live API on 2026-08-28. Two details are not guessable and cost
// a hung connection or a lost transcript if got wrong:
//
//   - End of stream on the realtime socket is an empty **text** frame. An empty binary
//     frame is silently not recognised: the server keeps waiting and eventually closes
//     with error_code 408 "Request timeout" having emitted no final transcript.
//   - The realtime transcript carries endpoint markers as tokens whose text is `<end>`.
//     They are protocol, not speech, and must be stripped or they land in the paste.
//
// Custom vocabulary is `context.terms`, and it works well: asked to transcribe audio
// containing "OpenWhispr", "Sinead" and "zohar-mac-mini", the realtime and async paths
// both returned all three exactly, where another provider's final pass gave
// "open whisper" and "Shinade" from the same recording.

const { normalizeDictationTerms } = require("./dictationTerms");

const SONIOX_REALTIME_MODEL = "stt-rt-v5";
const SONIOX_ASYNC_MODEL = "stt-async-v5";

const SONIOX_REALTIME_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const SONIOX_API_BASE = "https://api.soniox.com/v1";

// The recorder already produces 16 kHz mono PCM16 for upload, which is one of the raw
// formats Soniox accepts — so no re-encode, but sample_rate and num_channels become
// required rather than optional (they are only inferred for container formats).
const SONIOX_AUDIO_FORMAT = "s16le";
const SONIOX_SAMPLE_RATE = 16000;
const SONIOX_NUM_CHANNELS = 1;

// No documented ceiling on context terms, so this is the app's own restraint rather
// than a server limit: the terms are a bias, and a list long enough to contain half a
// dictionary stops being a hint about this dictation.
const SONIOX_TERM_LIMIT = 1000;

// Tokens the protocol uses to mark structure rather than speech.
const SONIOX_MARKER_TOKENS = new Set(["<end>", "<fin>"]);

/**
 * Terms cleaned for the `context` object.
 *
 * Shared with every other provider that takes a term list — see dictationTerms.js.
 */
function normalizeTerms(terms) {
  return normalizeDictationTerms(terms, { limit: SONIOX_TERM_LIMIT });
}

/** `context` is omitted entirely when empty — an empty terms array is not a hint. */
function buildContext(vocabulary) {
  const terms = normalizeTerms(vocabulary);
  return terms.length > 0 ? { terms } : undefined;
}

/** Language hints, omitted when the app does not know the language. */
function buildLanguageHints(language) {
  return language && language !== "auto" ? [language] : undefined;
}

/**
 * The first message on the realtime socket. The key travels in this message rather than
 * a header, because a browser-style WebSocket cannot set one.
 */
function buildRealtimeConfig({
  apiKey,
  model = SONIOX_REALTIME_MODEL,
  language,
  vocabulary,
  sampleRate = SONIOX_SAMPLE_RATE,
} = {}) {
  const config = {
    api_key: apiKey,
    model,
    audio_format: SONIOX_AUDIO_FORMAT,
    sample_rate: sampleRate,
    num_channels: SONIOX_NUM_CHANNELS,
    // Lets the server decide an utterance ended and finalize promptly, rather than
    // holding tokens open until the stream closes.
    enable_endpoint_detection: true,
  };
  const hints = buildLanguageHints(language);
  if (hints) config.language_hints = hints;
  const context = buildContext(vocabulary);
  if (context) config.context = context;
  return config;
}

/** True for a token that is protocol structure rather than transcribed speech. */
function isMarkerToken(token) {
  return SONIOX_MARKER_TOKENS.has((token?.text ?? "").trim());
}

/**
 * Classify one realtime message.
 *
 * Tokens arrive split into final and non-final. Finals are cumulative across messages —
 * each message carries only the newly finalized ones, so a consumer appends those and
 * *replaces* the interim tail. Getting that backwards duplicates text.
 *
 * @returns {{kind: "error"|"finished"|"tokens", finalText: string, interimText: string,
 *            error?: {code: unknown, message: string}}}
 */
function parseRealtimeMessage(message) {
  if (!message || typeof message !== "object") {
    return { kind: "tokens", finalText: "", interimText: "" };
  }

  if (message.error_code !== undefined || message.error_message) {
    return {
      kind: "error",
      finalText: "",
      interimText: "",
      error: {
        code: message.error_code,
        message: message.error_message || "Soniox stream error",
      },
    };
  }

  const tokens = Array.isArray(message.tokens) ? message.tokens : [];
  const usable = tokens.filter((token) => !isMarkerToken(token));
  const finalText = usable
    .filter((token) => token.is_final)
    .map((token) => token.text ?? "")
    .join("");
  const interimText = usable
    .filter((token) => !token.is_final)
    .map((token) => token.text ?? "")
    .join("");

  return {
    kind: message.finished ? "finished" : "tokens",
    finalText,
    interimText,
  };
}

/** Body for creating an async transcription of an already-uploaded file. */
function buildAsyncTranscriptionRequest({
  fileId,
  model = SONIOX_ASYNC_MODEL,
  language,
  vocabulary,
} = {}) {
  const body = { file_id: fileId, model };
  const hints = buildLanguageHints(language);
  if (hints) body.language_hints = hints;
  const context = buildContext(vocabulary);
  if (context) body.context = context;
  return body;
}

/**
 * The transcript from an async fetch.
 *
 * `text` is supplied directly, so the tokens are only a fallback for a response that
 * carries them without it. Markers are stripped from that fallback for the same reason
 * they are stripped from the realtime path.
 */
function parseAsyncTranscript(json) {
  if (typeof json?.text === "string" && json.text.trim()) return json.text.trim();
  const tokens = Array.isArray(json?.tokens) ? json.tokens : [];
  return tokens
    .filter((token) => !isMarkerToken(token))
    .map((token) => token.text ?? "")
    .join("")
    .trim();
}

/** Terminal states of an async job, so a poller knows when to stop. */
function asyncJobState(json) {
  const status = json?.status;
  if (status === "completed") return "completed";
  if (status === "error" || status === "failed") return "error";
  return "pending";
}

const SONIOX_PATHS = {
  files: "/files",
  transcriptions: "/transcriptions",
  transcription: (id) => `/transcriptions/${id}`,
  transcript: (id) => `/transcriptions/${id}/transcript`,
  file: (id) => `/files/${id}`,
};

module.exports = {
  SONIOX_REALTIME_MODEL,
  SONIOX_ASYNC_MODEL,
  SONIOX_REALTIME_URL,
  SONIOX_API_BASE,
  SONIOX_AUDIO_FORMAT,
  SONIOX_SAMPLE_RATE,
  SONIOX_NUM_CHANNELS,
  SONIOX_TERM_LIMIT,
  SONIOX_MARKER_TOKENS,
  SONIOX_PATHS,
  normalizeTerms,
  buildContext,
  buildLanguageHints,
  buildRealtimeConfig,
  isMarkerToken,
  parseRealtimeMessage,
  buildAsyncTranscriptionRequest,
  parseAsyncTranscript,
  asyncJobState,
};
