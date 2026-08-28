const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const S = require("../../src/utils/sonioxTranscribe.js");

// Confirmed against the live API on 2026-08-28. Two of these encode failures that cost
// a whole dictation and give no useful error, which is why they are tests and not
// comments: an unrecognised end-of-stream signal hangs until the server returns 408 with
// no transcript, and an unstripped `<end>` marker lands in the user's pasted text.

test("the realtime config declares the raw format the recorder produces", () => {
  // sample_rate and num_channels are only optional for container formats. With s16le
  // they are required, and omitting them is a rejected config rather than a default.
  const config = S.buildRealtimeConfig({ apiKey: "k", language: "en" });
  assert.equal(config.audio_format, "s16le");
  assert.equal(config.sample_rate, 16000);
  assert.equal(config.num_channels, 1);
  assert.equal(config.model, "stt-rt-v5");
  // The key travels in the config message: a browser-style WebSocket cannot set headers.
  assert.equal(config.api_key, "k");
});

test("endpoint detection is on, so an utterance finalizes without waiting for close", () => {
  assert.equal(S.buildRealtimeConfig({ apiKey: "k" }).enable_endpoint_detection, true);
});

test("vocabulary goes in context.terms, deduplicated and casing preserved", () => {
  const config = S.buildRealtimeConfig({
    apiKey: "k",
    vocabulary: ["  OpenWhispr ", "openwhispr", "OPENWHISPR", "", "   ", "Sinead", null, 7],
  });
  assert.deepEqual(config.context, { terms: ["OpenWhispr", "Sinead"] });
});

test("context is omitted entirely when there are no terms", () => {
  // An empty terms array is not a hint, and sending one says something untrue about
  // what the speaker's vocabulary is.
  for (const vocabulary of [[], null, undefined, ["", "  "]]) {
    assert.ok(
      !("context" in S.buildRealtimeConfig({ apiKey: "k", vocabulary })),
      `${JSON.stringify(vocabulary)} should not produce a context`
    );
  }
});

test("a known language becomes a hint and auto omits it", () => {
  assert.deepEqual(S.buildRealtimeConfig({ apiKey: "k", language: "en" }).language_hints, ["en"]);
  for (const language of ["auto", "", null, undefined]) {
    assert.ok(!("language_hints" in S.buildRealtimeConfig({ apiKey: "k", language })));
  }
});

test("endpoint marker tokens are recognised as protocol, not speech", () => {
  // The real trap: `<end>` arrives as a token with is_final true, so a consumer that
  // just concatenates final tokens pastes it into the user's document.
  assert.equal(S.isMarkerToken({ text: "<end>" }), true);
  assert.equal(S.isMarkerToken({ text: " <end> " }), true);
  assert.equal(S.isMarkerToken({ text: "<fin>" }), true);
  assert.equal(S.isMarkerToken({ text: "end" }), false);
  assert.equal(S.isMarkerToken({ text: "Let's" }), false);
  assert.equal(S.isMarkerToken({}), false);
});

test("a realtime message splits into final and interim, with markers stripped", () => {
  // Shape taken from a live session, including the marker that follows the last word.
  const parsed = S.parseRealtimeMessage({
    tokens: [
      { text: "Let's ship", is_final: true },
      { text: "<end>", is_final: true },
      { text: " the", is_final: false },
    ],
  });
  assert.equal(parsed.kind, "tokens");
  assert.equal(parsed.finalText, "Let's ship", "the marker must not reach the transcript");
  assert.equal(parsed.interimText, " the");
});

test("finals accumulate across messages while interim is replaced", () => {
  // Each message carries only newly finalized tokens, so a consumer appends finals and
  // replaces the interim tail. Appending interim instead would duplicate every word as
  // it firms up.
  const messages = [
    {
      tokens: [
        { text: "Let's", is_final: true },
        { text: " sh", is_final: false },
      ],
    },
    {
      tokens: [
        { text: " ship", is_final: true },
        { text: " the", is_final: false },
      ],
    },
    {
      tokens: [
        { text: " the build.", is_final: true },
        { text: "<end>", is_final: true },
      ],
    },
  ];
  let final = "";
  let interim = "";
  for (const message of messages) {
    const parsed = S.parseRealtimeMessage(message);
    final += parsed.finalText;
    interim = parsed.interimText;
  }
  assert.equal(final, "Let's ship the build.");
  assert.equal(interim, "", "the interim tail is empty once everything is final");
});

test("an error message is classified as an error, not as empty tokens", () => {
  // error_code 0 is falsy, so a truthiness check would misread a real error as a normal
  // empty message and hang waiting for a transcript that is never coming.
  //
  // Tested with NO error_message alongside it, on purpose: with a message present the
  // truthiness check passes anyway on the message, which is how the first version of
  // this test failed to catch the bug it was written for.
  const codeOnly = S.parseRealtimeMessage({ error_code: 0 });
  assert.equal(codeOnly.kind, "error", "a falsy error_code is still an error");
  assert.equal(codeOnly.error.code, 0);

  const parsed = S.parseRealtimeMessage({
    error_code: 0,
    error_message: "something went wrong",
  });
  assert.equal(parsed.kind, "error");
  assert.equal(parsed.error.message, "something went wrong");

  const timeout = S.parseRealtimeMessage({ error_code: 408, error_message: "Request timeout." });
  assert.equal(timeout.kind, "error");
  assert.equal(timeout.error.code, 408);
});

test("finished is reported so a consumer knows to stop waiting", () => {
  const parsed = S.parseRealtimeMessage({ finished: true, tokens: [] });
  assert.equal(parsed.kind, "finished");
});

test("a malformed message is tolerated rather than thrown on", () => {
  for (const message of [null, undefined, 42, "text", {}, { tokens: null }]) {
    const parsed = S.parseRealtimeMessage(message);
    assert.equal(parsed.finalText, "");
    assert.equal(parsed.interimText, "");
  }
});

test("the async create request references the uploaded file", () => {
  const body = S.buildAsyncTranscriptionRequest({
    fileId: "abc",
    language: "en",
    vocabulary: ["OpenWhispr"],
  });
  assert.equal(body.file_id, "abc");
  assert.equal(body.model, "stt-async-v5");
  assert.deepEqual(body.language_hints, ["en"]);
  assert.deepEqual(body.context, { terms: ["OpenWhispr"] });
});

test("the async transcript prefers text and falls back to tokens", () => {
  assert.equal(S.parseAsyncTranscript({ text: "Let's ship the build." }), "Let's ship the build.");
  // Fallback for a response that carries tokens without text, markers stripped there too.
  assert.equal(
    S.parseAsyncTranscript({
      tokens: [{ text: "Let's ship" }, { text: "<end>" }, { text: " it." }],
    }),
    "Let's ship it."
  );
  for (const json of [null, {}, { text: "   " }, { tokens: [] }]) {
    assert.equal(S.parseAsyncTranscript(json), "");
  }
});

test("async job states map to completed, error and pending", () => {
  assert.equal(S.asyncJobState({ status: "completed" }), "completed");
  assert.equal(S.asyncJobState({ status: "error" }), "error");
  assert.equal(S.asyncJobState({ status: "failed" }), "error");
  for (const status of ["queued", "processing", undefined, null, "something_new"]) {
    assert.equal(
      S.asyncJobState({ status }),
      "pending",
      `${status} must be treated as pending, not silently completed`
    );
  }
});

// --- wiring ---

const audioManager = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "helpers", "audioManager.js"),
  "utf8"
);

test("the soniox lane sends dictionary plus screen terms", () => {
  const start = audioManager.indexOf("async transcribeWithSonioxAsync(");
  assert.ok(start > 0, "the soniox method is missing");
  const method = audioManager.slice(start, start + 3200);
  assert.match(
    method,
    /getProviderTerms\("soniox"\)/,
    "must get its terms from the shared shaper, which applies soniox's cap"
  );
  assert.match(
    method,
    /buildSonioxAsyncRequest\(/,
    "must build the request with the shared module"
  );
  assert.match(method, /parseSonioxAsyncTranscript\(/, "must parse with the shared module");
});

test("the recording is deleted from soniox even when the job fails", () => {
  // It is the user's dictation. Leaving it on a third party's servers after transcribing
  // is not acceptable, and a failed job is exactly when it would be forgotten — so the
  // deletes live in a finally, not on the success path.
  const start = audioManager.indexOf("async transcribeWithSonioxAsync(");
  const method = audioManager.slice(start, start + 3600);

  const finallyAt = method.indexOf("} finally {");
  assert.ok(finallyAt > 0, "cleanup must be in a finally block");
  const cleanup = method.slice(finallyAt);
  assert.match(cleanup, /SONIOX_PATHS\.transcription\(/, "the transcription must be deleted");
  assert.match(cleanup, /SONIOX_PATHS\.file\(/, "the uploaded file must be deleted");
  assert.match(cleanup, /"DELETE"/, "cleanup must actually issue DELETEs");
});

test("polling is bounded, so a stuck job cannot wait forever", () => {
  const start = audioManager.indexOf("async transcribeWithSonioxAsync(");
  const method = audioManager.slice(start, start + 3200);
  assert.match(method, /SONIOX_ASYNC_TIMEOUT_MS/, "the poll loop needs a ceiling");
  assert.match(method, /SONIOX_ASYNC_POLL_MS/, "and an interval between attempts");
});

test("gemini and soniox work as the single provider, not just as lanes", () => {
  // The bug this covers: both were added to the multi-transcription fan-out only, so
  // choosing either as the *only* provider fell through to the OpenAI-compatible table,
  // which has no entry for them, and failed with "no transcription endpoint configured"
  // — while the same provider transcribed fine as a lane.
  assert.match(
    audioManager,
    /if \(provider === "gemini" \|\| provider === "soniox"\) \{\s*\n\s*const oneShotText = await this\.transcribeOneShotWithProvider\(/,
    "the single-provider path must handle them"
  );

  // And both paths must call the same request builder, or they can diverge again.
  const calls = audioManager.match(/this\.transcribeOneShotWithProvider\(/g) ?? [];
  assert.ok(
    calls.length >= 2,
    `both the fan-out and the single-provider path must use it, saw ${calls.length}`
  );
  const definitions = audioManager.match(/async transcribeOneShotWithProvider\(/g) ?? [];
  assert.equal(definitions.length, 1, "there must be exactly one such builder");
});

test("both providers have somewhere to enter their key", () => {
  // Without a provider tab and a credential field there is no way to enter the key at
  // all: the lane reports it missing and the settings page offers no input. OpenRouter
  // had the same gap and only worked because a key happened to be in the bundled env.
  const picker = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "components", "TranscriptionModelPicker.tsx"),
    "utf8"
  );
  for (const [tab, field] of [
    ["soniox", "sonioxApiKey"],
    ["gemini", "geminiApiKey"],
    ["openrouter", "openrouterApiKey"],
  ]) {
    assert.match(
      picker,
      new RegExp(`id: "${tab}"`),
      `${tab} needs a provider tab or its credential field is unreachable`
    );
    assert.match(
      picker,
      new RegExp(`key: "${field}", input: "secret"`),
      `${tab} needs a secret credential field`
    );
    // A field with no value/setter wiring renders empty and silently discards input.
    assert.match(picker, new RegExp(`${field},`), `${field} must be in the values map`);
    assert.match(
      picker,
      new RegExp(`${field}: set[A-Za-z]+,`),
      `${field} must be in the setters map`
    );
  }
});

test("batch is the default mode, and it is selectable", () => {
  // Selecting Soniox as the single provider used to always route to the realtime socket
  // with no way to ask for the async path — so "batch mode" was unreachable.
  const config = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "config", "multiTranscription.ts"),
    "utf8"
  );
  assert.match(config, /DEFAULT_SONIOX_TRANSCRIPTION_MODE = "batch"/);

  const store = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "stores", "settingsStore.ts"),
    "utf8"
  );
  assert.match(
    store,
    /"sonioxTranscriptionMode",\s*\n?\s*DEFAULT_SONIOX_TRANSCRIPTION_MODE/,
    "the store must seed from the shared constant"
  );
  // xAI's default moved to batch for the same reason.
  assert.match(config, /DEFAULT_XAI_TRANSCRIPTION_MODE = "batch"/);
  assert.match(store, /"xaiTranscriptionMode", DEFAULT_XAI_TRANSCRIPTION_MODE/);

  const picker = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "components", "TranscriptionModelPicker.tsx"),
    "utf8"
  );
  assert.match(picker, /key: "sonioxTranscriptionMode"/, "the mode needs a control");
  assert.match(picker, /sonioxTranscriptionMode: setSonioxTranscriptionMode/, "wired to its setter");
});

test("the streaming route is skipped when the mode is batch", () => {
  // Without this the mode selector would render and change nothing.
  assert.match(
    audioManager,
    /s\.sonioxTranscriptionMode !== "batch"/,
    "streaming must be conditional on the mode"
  );
});
