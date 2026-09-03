// Wire format for Meta's Muse Voice Transcribe, both variants.
//
//   realtime  muse-voice-transcribe-1.0  WSS wss://api.meta.ai/v1/asr/realtime
//   batch     muse-voice-transcribe-1.0  POST https://api.meta.ai/v1/asr/transcribe
//
// Confirmed against the live API on 2026-09-03. Both paths returned the full sentence
// from a real dictation, and the realtime one produced its final transcript 61ms after
// end-of-stream — the same order as Soniox, and an order faster than any batch lane.
//
// Three details are not guessable and each costs a hung socket or a lost transcript:
//
//   - The session id is a query parameter on both paths, not a body field.
//   - Realtime authentication travels in the *first message*, not in a header: the
//     opening JSON frame carries authorization.accessToken, and the value includes the
//     "Bearer " prefix inside the string. There is a 10 second deadline on it.
//   - End of stream is a JSON text frame `{"type":"endStream"}`. Nothing is emitted
//     after it, so the final transcript must already have been read.
//
// Partials are cumulative by default (partialMode CUMULATIVE), so each one replaces the
// last rather than extending it — the opposite of Soniox, whose finals are increments.

const { normalizeDictationTerms } = require("./dictationTerms");

const META_MODEL = "muse-voice-transcribe-1.0";

const META_API_BASE = "https://api.meta.ai/v1";
const META_REALTIME_URL = "wss://api.meta.ai/v1/asr/realtime";
const META_PATHS = { transcribe: "/asr/transcribe" };

// PUSH_TO_TALK rather than ENDPOINTING or DIARIZATION: a dictation is one utterance that
// ends when the user releases the key, and this app already knows when that is. The other
// modes report per-turn `speechComplete` events and leave the caller to decide when the
// utterance is over — machinery for a conversation, not a dictation.
const META_MODE = "PUSH_TO_TALK";

// The recorder produces 16 kHz mono PCM16, which is one of the two encodings the socket
// takes as-is. 24 kHz is the other; neither needs a container.
const META_AUDIO_ENCODING = "PCM_16KHZ";
const META_BATCH_AUDIO_ENCODING = "WAV";
const META_SAMPLE_RATE = 16000;

// Keyword biasing. No documented ceiling, so this matches the limit Gemini and Soniox
// get: the terms are a hint about this dictation, and a list long enough to hold half a
// dictionary stops being one.
const META_TERM_LIMIT = 1000;

/** Shared shaping, so every provider biases from the same list in the same order. */
function normalizeTerms(terms) {
  return normalizeDictationTerms(terms, { limit: META_TERM_LIMIT });
}

/**
 * Language hint. The API takes prose language names ("English"), not codes, and treats
 * the list as a bias rather than a lock — so an unknown or absent language is simply
 * omitted and the model detects it, which is its default.
 */
function buildLanguageBias(language, languageName) {
  const name = String(languageName || "").trim();
  if (!name || !language || language === "auto") return undefined;
  return [name];
}

/** Everything both paths configure identically. */
function buildCommonConfig({ vocabulary, language, languageName } = {}) {
  const config = { model: META_MODEL, mode: META_MODE };

  const keywords = normalizeTerms(vocabulary);
  if (keywords.length) config.keywords = keywords;

  const languageBias = buildLanguageBias(language, languageName);
  if (languageBias) config.languageBias = languageBias;

  return config;
}

/**
 * The opening frame for the realtime socket.
 *
 * Sent as the first text frame within ten seconds of connecting, or the server closes.
 * The token keeps its "Bearer " prefix inside the string — this is not a header.
 */
function buildRealtimeHandshake({ apiKey, vocabulary, language, languageName } = {}) {
  return {
    authorization: { accessToken: `Bearer ${apiKey}` },
    audioEncoding: META_AUDIO_ENCODING,
    partialMode: "CUMULATIVE",
    // Off: it fires several times a second per socket and carries nothing this app uses.
    // Left on, a five second dictation logged over a hundred of them.
    emitAudioProgress: false,
    ...buildCommonConfig({ vocabulary, language, languageName }),
  };
}

/** `{"type":"endStream"}` as a text frame. Nothing arrives after it. */
function buildEndOfStream() {
  return { type: "endStream" };
}

/** Realtime URL, with the session id the API wants as a query parameter. */
function buildRealtimeUrl(sessionId) {
  const id = String(sessionId || "").trim();
  return id ? `${META_REALTIME_URL}?sessionId=${encodeURIComponent(id)}` : META_REALTIME_URL;
}

/**
 * Classify one message from the realtime socket.
 *
 * @returns {{kind: string, text?: string}} kind is one of setup, partial, final,
 *   progress, ignore.
 */
function parseRealtimeMessage(message) {
  let parsed = message;
  if (typeof message === "string") {
    try {
      parsed = JSON.parse(message);
    } catch {
      return { kind: "ignore" };
    }
  }
  if (!parsed || typeof parsed !== "object") return { kind: "ignore" };

  // The handshake acknowledgement is the session id on its own, with no type field.
  if (!parsed.type && parsed.sessionId) return { kind: "setup" };

  switch (parsed.type) {
    case "transcript":
      // Cumulative: every transcript event carries the whole utterance so far, final or
      // not, so both replace rather than append.
      return { kind: parsed.final ? "final" : "partial", text: parsed.transcript ?? "" };
    case "speechComplete":
      // Only emitted by ENDPOINTING and DIARIZATION, which this app does not use. Mapped
      // anyway so a mode change does not silently drop the one event that carries a
      // transcript.
      return { kind: "final", text: parsed.transcript ?? "" };
    case "audioProgress":
      return { kind: "progress" };
    default:
      // speechStart, speechEnd, speaker: structure, not speech.
      return { kind: "ignore" };
  }
}

/** Batch URL. The session id is a query parameter here too. */
function buildBatchUrl(sessionId, base = META_API_BASE) {
  const id = String(sessionId || "").trim();
  const url = `${base}${META_PATHS.transcribe}`;
  return id ? `${url}?sessionId=${encodeURIComponent(id)}` : url;
}

/**
 * The JSON `request` part of the batch multipart body.
 *
 * The audio goes in a second part named `audio` — not `file`, which is what every
 * OpenAI-shaped endpoint calls it, so this cannot ride the shared multipart helper.
 */
function buildBatchRequest({ vocabulary, language, languageName } = {}) {
  return {
    audioEncoding: META_BATCH_AUDIO_ENCODING,
    ...buildCommonConfig({ vocabulary, language, languageName }),
  };
}

/** The transcript from a batch response, or "" if it carried none. */
function parseBatchResponse(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.transcript === "string") return payload.transcript.trim();
  // Turn-level fallback: DIARIZATION and ENDPOINTING answer in `turns` with no top-level
  // transcript. Unused at PUSH_TO_TALK, and cheap insurance against a mode change.
  if (Array.isArray(payload.turns)) {
    return payload.turns
      .map((turn) => (turn && typeof turn.transcript === "string" ? turn.transcript : ""))
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return "";
}

module.exports = {
  META_MODEL,
  META_API_BASE,
  META_REALTIME_URL,
  META_PATHS,
  META_MODE,
  META_AUDIO_ENCODING,
  META_BATCH_AUDIO_ENCODING,
  META_SAMPLE_RATE,
  META_TERM_LIMIT,
  normalizeTerms,
  buildLanguageBias,
  buildRealtimeHandshake,
  buildEndOfStream,
  buildRealtimeUrl,
  parseRealtimeMessage,
  buildBatchUrl,
  buildBatchRequest,
  parseBatchResponse,
};
