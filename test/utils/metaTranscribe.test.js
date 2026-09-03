const test = require("node:test");
const assert = require("node:assert/strict");

const meta = require("../../src/utils/metaTranscribe");
const { metaRealtimeDialect } = require("../../src/helpers/liveTranscriptionDialects");

// Everything here was confirmed against the live API on 2026-09-03: the batch endpoint
// returned the full sentence from a real dictation, and the socket produced its final
// transcript 37-81ms after end-of-stream when driven through this app's own
// LiveTranscriptionSocket. These tests pin the details that are not guessable, each of
// which costs a hung socket or a lost transcript rather than an error.

test("the realtime handshake carries the token in the message, not a header", () => {
  // There is no Authorization header on this socket. The opening frame carries the token,
  // and the "Bearer " prefix lives inside the string — a bare key is rejected.
  const setup = meta.buildRealtimeHandshake({ apiKey: "abc123" });
  assert.equal(setup.authorization.accessToken, "Bearer abc123");
  assert.equal(setup.model, "muse-voice-transcribe-1.0");
  assert.equal(setup.audioEncoding, "PCM_16KHZ");
});

test("partials are cumulative, so the consumer must replace rather than append", () => {
  // CUMULATIVE is requested explicitly. Under DELTA each event carries only the new
  // words, and a consumer that replaces would keep just the last fragment.
  assert.equal(meta.buildRealtimeHandshake({ apiKey: "k" }).partialMode, "CUMULATIVE");
});

test("audio progress is off, or it drowns the log", () => {
  // Left on, a six second dictation emitted over a hundred of these, several a second
  // per socket, carrying nothing this app uses.
  assert.equal(meta.buildRealtimeHandshake({ apiKey: "k" }).emitAudioProgress, false);
});

test("the session id goes in the URL on both paths", () => {
  assert.match(meta.buildRealtimeUrl("sess-1"), /\?sessionId=sess-1$/);
  assert.match(meta.buildBatchUrl("sess-2"), /\/asr\/transcribe\?sessionId=sess-2$/);
  // Absent rather than empty: a blank query parameter is not the same as none.
  assert.ok(!meta.buildRealtimeUrl("").includes("?"));
});

test("end of stream is a JSON text frame, and nothing arrives after it", () => {
  assert.deepEqual(meta.buildEndOfStream(), { type: "endStream" });
  assert.equal(metaRealtimeDialect.buildEndOfStream(), '{"type":"endStream"}');
});

test("a final transcript both sets the text and ends the stream", () => {
  // In PUSH_TO_TALK there is exactly one final and it arrives after end-of-stream. If the
  // dialect reported it as a plain final the socket would wait out its whole final-wait
  // window for a completion signal that never comes.
  const event = metaRealtimeDialect.parseMessage(
    JSON.stringify({ type: "transcript", transcript: "all of it", final: true })
  );
  assert.deepEqual(event, { kind: "finished", text: "all of it", replaces: true });
});

test("a partial is a partial, and structure events are ignored", () => {
  assert.deepEqual(
    metaRealtimeDialect.parseMessage(
      JSON.stringify({ type: "transcript", transcript: "part", final: false })
    ),
    { kind: "partial", text: "part" }
  );
  assert.equal(metaRealtimeDialect.parseMessage(JSON.stringify({ type: "audioProgress" })), null);
  assert.equal(metaRealtimeDialect.parseMessage(JSON.stringify({ type: "speechStart" })), null);
  // The handshake acknowledgement is the session id alone, with no type field.
  assert.deepEqual(metaRealtimeDialect.parseMessage(JSON.stringify({ sessionId: "x" })), {
    kind: "setup",
  });
});

test("keywords are the biasing parameter, capped like the other full-size lanes", () => {
  const many = Array.from({ length: meta.META_TERM_LIMIT + 50 }, (_, i) => `term${i}`);
  const setup = meta.buildRealtimeHandshake({ apiKey: "k", vocabulary: many });
  assert.equal(setup.keywords.length, meta.META_TERM_LIMIT);
  // No keywords means no key at all, rather than an empty array.
  assert.ok(!("keywords" in meta.buildRealtimeHandshake({ apiKey: "k", vocabulary: [] })));
});

test("the language hint is a prose name, and absent when unknown", () => {
  const named = meta.buildBatchRequest({ language: "en", languageName: "English" });
  assert.deepEqual(named.languageBias, ["English"]);
  // "auto" means the model's own detection, which is its default — so no hint at all.
  assert.ok(!("languageBias" in meta.buildBatchRequest({ language: "auto", languageName: "English" })));
  assert.ok(!("languageBias" in meta.buildBatchRequest({ language: "en" })));
});

test("the batch request names the audio format the recorder actually produces", () => {
  assert.equal(meta.buildBatchRequest({}).audioEncoding, "WAV");
  assert.equal(meta.buildBatchRequest({}).mode, "PUSH_TO_TALK");
});

test("the batch transcript is read from the top level, with a turn-level fallback", () => {
  assert.equal(meta.parseBatchResponse({ transcript: "  hello  " }), "hello");
  // ENDPOINTING and DIARIZATION answer in turns with no top-level transcript. Unused at
  // PUSH_TO_TALK, and cheap insurance against a mode change.
  assert.equal(
    meta.parseBatchResponse({ turns: [{ transcript: "one" }, { transcript: "two" }] }),
    "one two"
  );
  assert.equal(meta.parseBatchResponse({}), "");
  assert.equal(meta.parseBatchResponse(null), "");
});
