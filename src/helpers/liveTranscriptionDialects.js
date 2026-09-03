// The provider-specific half of streaming transcription. Everything about sequencing
// lives in liveTranscriptionSocket.js; these only say what goes on the wire, reusing the
// same request builders and parsers the batch paths use so the two cannot drift.
//
// Both differences that matter here were found by driving the real sockets, and both are
// silent failures rather than errors:
//
//   Gemini closes the connection on anything sent before `setupComplete` arrives, so it
//   needs setup acknowledgement. Its audio is base64 inside a JSON envelope.
//
//   Soniox accepts audio immediately after its config message and takes raw binary
//   frames. Its end-of-stream is an empty *text* frame — an empty binary frame is
//   ignored and the server eventually closes with error_code 408 and no transcript.
//
//   Meta authenticates in its opening frame like Soniox, but carries the session id in
//   the URL and ends the stream with a JSON `{"type":"endStream"}` text frame. Its
//   partials are cumulative, so each one replaces the last rather than extending it.

const gemini = require("../utils/geminiTranscribe");
const soniox = require("../utils/sonioxTranscribe");
const meta = require("../utils/metaTranscribe");

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.language] - App language code, or "auto" to omit the hint.
 * @param {string[]} [options.vocabulary] - Custom dictionary plus on-screen terms.
 */
const geminiLiveDialect = {
  name: "gemini-live",
  defaultModel: gemini.GEMINI_TRANSCRIBE_LIVE_MODEL,

  buildUrl: (options) => gemini.buildLiveUrl(options.apiKey),

  // Audio before this is acknowledged closes the socket.
  needsSetupAck: true,

  buildSetup: (options) =>
    gemini.buildLiveSetup({
      model: options.model || gemini.GEMINI_TRANSCRIBE_LIVE_MODEL,
      language: options.language,
      vocabulary: options.vocabulary,
      mode: options.mode,
    }),

  encodeAudio: (buffer) => JSON.stringify(gemini.buildLiveAudioChunk(buffer.toString("base64"))),

  buildEndOfStream: () => JSON.stringify(gemini.buildLiveAudioStreamEnd()),

  parseMessage: (message) => {
    const parsed = gemini.parseLiveMessage(message);
    switch (parsed.kind) {
      case "setup":
        return { kind: "setup" };
      case "partial":
        return { kind: "partial", text: parsed.text };
      case "final":
        // One per *speech segment*, not one per utterance: a pause makes Gemini finalise
        // what it has and start a new segment. Confirmed against the live API — three
        // phrases separated by one-second silences produced two finals, the first
        // arriving mid-recording. Replacing here kept only the last segment; appending is
        // what reassembles the dictation.
        return { kind: "final", text: parsed.text, replaces: false };
      case "done":
        // generationComplete closes a *segment*, and one arrives after every pause, so it
        // cannot mean the stream is over. The socket decides that, from whether
        // end-of-stream has been sent — otherwise the first pause ended the dictation and
        // everything after it was thrown away.
        return { kind: "segment-end" };
      default:
        return null;
    }
  },
};

const sonioxRealtimeDialect = {
  name: "soniox-realtime",
  defaultModel: soniox.SONIOX_REALTIME_MODEL,

  buildUrl: () => soniox.SONIOX_REALTIME_URL,

  // The config message doubles as authentication and needs no acknowledgement: audio may
  // follow immediately.
  needsSetupAck: false,

  buildSetup: (options) =>
    soniox.buildRealtimeConfig({
      apiKey: options.apiKey,
      model: options.model || soniox.SONIOX_REALTIME_MODEL,
      language: options.language,
      vocabulary: options.vocabulary,
      sampleRate: options.sampleRate,
    }),

  // Raw binary frames, no envelope and no base64.
  encodeAudio: (buffer) => buffer,

  // Empty TEXT frame. An empty binary frame is silently not recognised.
  buildEndOfStream: () => "",

  parseMessage: (message) => {
    const parsed = soniox.parseRealtimeMessage(message);
    if (parsed.kind === "error") return { kind: "error", error: parsed.error };

    // One frame carries both halves: the tokens that just became final, and the
    // unfinalised tail. Emitted as two events in that order — returning only the final
    // would drop the tail from the live preview, and returning only the partial would
    // lose committed words. Finals are increments, so they append.
    const events = [];
    if (parsed.finalText) {
      events.push({ kind: "final", text: parsed.finalText, replaces: false });
    }
    if (parsed.interimText) {
      events.push({ kind: "partial", text: parsed.interimText });
    }
    if (parsed.kind === "finished") {
      // The text, if any, was already emitted as a final above.
      events.push({ kind: "finished" });
    }
    return events.length > 0 ? events : null;
  },
};

const metaRealtimeDialect = {
  name: "meta-realtime",
  defaultModel: meta.META_MODEL,

  // The session id belongs in the URL rather than the opening frame, and the server does
  // not mind it being ours: it echoes back its own in the handshake acknowledgement.
  buildUrl: () => meta.buildRealtimeUrl(crypto.randomUUID()),

  // No acknowledgement needed — verified against the live socket, which accepted audio
  // sent immediately after the handshake and only acknowledged it 667ms later. Waiting
  // for that would have buffered most of a short dictation for nothing.
  needsSetupAck: false,

  buildSetup: (options) =>
    meta.buildRealtimeHandshake({
      apiKey: options.apiKey,
      language: options.language,
      languageName: options.languageName,
      vocabulary: options.vocabulary,
    }),

  // Raw binary PCM16, no envelope.
  encodeAudio: (buffer) => buffer,

  buildEndOfStream: () => JSON.stringify(meta.buildEndOfStream()),

  parseMessage: (message) => {
    const parsed = meta.parseRealtimeMessage(message);
    switch (parsed.kind) {
      case "setup":
        return { kind: "setup" };
      case "partial":
        return { kind: "partial", text: parsed.text };
      case "final":
        // In PUSH_TO_TALK there is exactly one of these and it arrives after
        // end-of-stream, carrying the whole utterance — so it both sets the text and ends
        // the stream. Measured at 61ms after endStream on a six second dictation.
        return { kind: "finished", text: parsed.text, replaces: true };
      default:
        return null;
    }
  },
};

module.exports = { geminiLiveDialect, sonioxRealtimeDialect, metaRealtimeDialect };
