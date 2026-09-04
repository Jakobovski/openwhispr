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

test("every provider with its own request works as the single provider, not just as a lane", () => {
  // The bug this covers: a provider added to the multi-transcription fan-out only, so
  // choosing it as the *only* provider fell through to the OpenAI-compatible table,
  // which has no entry for it, and failed with "no transcription endpoint configured"
  // — while the same provider transcribed fine as a lane.
  //
  // Checked per provider rather than as one fixed expression: this held "gemini || soniox"
  // literally, so adding a third provider with its own request shape did not fail here —
  // it just silently did not reach the single-provider path.
  const oneShot = ["gemini", "soniox", "meta"];
  const branch = audioManager.slice(
    audioManager.indexOf('if (provider === "gemini"'),
    audioManager.indexOf("const oneShotText = await this.transcribeOneShotWithProvider(")
  );
  for (const provider of oneShot) {
    assert.ok(
      branch.includes(`provider === "${provider}"`),
      `${provider} must reach the single-provider path, not the OpenAI-compatible table`
    );
    assert.ok(
      audioManager.includes(`if (provider === "${provider}") {`),
      `${provider} needs its own request in transcribeOneShotWithProvider`
    );
  }

  // And both paths must call the same request builder, or they can diverge again.
  const calls = audioManager.match(/this\.transcribeOneShotWithProvider\(/g) ?? [];
  assert.ok(
    calls.length >= 2,
    `both the fan-out and the single-provider path must use it, saw ${calls.length}`
  );
  const definitions = audioManager.match(/async transcribeOneShotWithProvider\(/g) ?? [];
  assert.equal(definitions.length, 1, "there must be exactly one such builder");
});

test("every configured lane has somewhere to enter its key", () => {
  // Without a provider tab and a credential field there is no way to enter the key at
  // all: the lane reports it missing and the settings page offers no input.
  //
  // Derived from the lane table rather than a list of provider names. This test existed
  // and named soniox, gemini and openrouter — so azure-speech and meta both shipped as
  // *default* lanes with no tab, no key field and no streaming control, and the picker's
  // fallback rendered OpenAI's key input under their tabs. Naming the providers is what
  // let it happen twice.
  const root = path.join(__dirname, "..", "..");
  const picker = fs.readFileSync(
    path.join(root, "src", "components", "TranscriptionModelPicker.tsx"),
    "utf8"
  );
  const lanes = fs.readFileSync(path.join(root, "src", "config", "multiTranscription.ts"), "utf8");

  // id/apiKeyField pairs straight out of the lane table.
  const configured = [
    ...lanes.matchAll(
      /id: "([a-z-]+)",\s*\n\s*label: "[^"]*",\s*\n\s*model: "[^"]*",\s*\n\s*apiKeyField: "([a-zA-Z]+)",/g
    ),
  ].map((m) => [m[1], m[2]]);
  const inline = [
    ...lanes.matchAll(
      /\{ id: "([a-z-]+)", label: "[^"]*", model: "[^"]*", apiKeyField: "([a-zA-Z]+)" \}/g
    ),
  ].map((m) => [m[1], m[2]]);
  const all = [...configured, ...inline];
  assert.ok(all.length >= 5, `expected to find the lane table, parsed ${all.length} lanes`);

  for (const [id, field] of all) {
    assert.match(picker, new RegExp(`id: "${id}"`), `${id} needs a provider tab`);
    assert.match(picker, new RegExp(`"?${field}"?`), `${id} needs a ${field} credential field`);
    assert.ok(
      new RegExp(`"?${id}"?: \\{`).test(picker),
      `${id} needs a PROVIDER_CREDENTIALS entry, or its tab shows another provider's fields`
    );
  }
});

test("the credential panel never falls back to another provider's fields", () => {
  // Rendering OpenAI's key input under a different provider's tab is worse than showing
  // nothing: it looks editable and writes to the wrong key, which is exactly what hid the
  // two missing lanes above.
  const picker = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "components", "TranscriptionModelPicker.tsx"),
    "utf8"
  );
  assert.doesNotMatch(
    picker,
    /PROVIDER_CREDENTIALS\[selectedCloudProvider\] \?\? PROVIDER_CREDENTIALS\./
  );
});

test("every streaming-capable provider gets a mode control, seeded from one default", () => {
  // Soniox as a *batch* lane was measured at 3859ms for a 19-second recording against a
  // 2500ms lane budget, so the fan-out dropped it every time. Streaming is the fix, and
  // which path runs has to be selectable rather than inferred — for every provider that
  // offers both, not just the one that prompted it.
  const config = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "config", "multiTranscription.ts"),
    "utf8"
  );
  const store = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "stores", "settingsStore.ts"),
    "utf8"
  );
  const picker = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "components", "TranscriptionModelPicker.tsx"),
    "utf8"
  );

  assert.match(config, /DEFAULT_PROVIDER_TRANSCRIPTION_MODE = TRANSCRIPTION_MODE_BATCH/);

  // Derived from the table, so a provider added there without a control or a store field
  // fails here rather than rendering a dropdown that changes nothing.
  const table = config.slice(
    config.indexOf("export const STREAMING_CAPABLE_PROVIDERS"),
    config.indexOf("export const TRANSCRIPTION_MODE_BATCH")
  );
  const entries = [...table.matchAll(/\{ id: "([a-z-]+)", modeKey: "([A-Za-z]+)" \}/g)];
  assert.ok(entries.length >= 3, `expected the streaming-capable providers, saw ${entries.length}`);

  for (const [, id, modeKey] of entries) {
    // Seeded from a named constant, not a bare string. Batch is the shared default;
    // a provider whose streaming path is decisively better may name the streaming
    // constant instead — Meta's socket answers 37-81ms after the last frame against a
    // whole round trip for its batch endpoint, and it holds slot A. What must not happen
    // is a second literal default drifting from the store's, which is the rule
    // settingsDefaults.test.js enforces everywhere else.
    assert.match(
      store,
      new RegExp(
        `"${modeKey}",?\\s*\\n?\\s*(DEFAULT_PROVIDER_TRANSCRIPTION_MODE|TRANSCRIPTION_MODE_STREAMING|TRANSCRIPTION_MODE_BATCH)`
      ),
      `${id}: the store must seed ${modeKey} from a mode constant, not a literal`
    );
    // The control itself is generated from this same table, so what has to be true per
    // provider is that it has a credential entry to attach to and a wired setter. This
    // used to look for a hand-written `key: "<modeKey>"`, which is exactly the duplication
    // that let a streaming-capable provider ship with no control at all.
    assert.match(
      picker,
      new RegExp(`"?${id}"?: \\{\\s*\\n\\s*consoleUrl`),
      `${id} needs a PROVIDER_CREDENTIALS entry, or the generated mode control has nowhere to go`
    );
    assert.match(
      picker,
      new RegExp(`${modeKey}: set[A-Za-z]+,`),
      `${id}'s mode control must be wired to a setter`
    );
  }
});

test("the streaming route is table-driven, not a branch per provider", () => {
  // The whole point of the table: adding a provider should not mean another `if` here.
  assert.match(
    audioManager,
    /providerWantsStreaming\(s\.cloudTranscriptionProvider, s\)/,
    "routing must consult the shared helper"
  );
  assert.doesNotMatch(
    audioManager,
    /s\.sonioxTranscriptionMode !== "batch"/,
    "the per-provider branch should be gone"
  );
});

test("the mode control is generated from the streaming table, not written per provider", () => {
  // The design fault this closes: STREAMING_CAPABLE_PROVIDERS decided which providers
  // stream at runtime, and a separate hand-written `fields` array decided whether the UI
  // offered the choice. Nothing tied them together, so Meta shipped streaming-capable
  // with no dropdown — and the failure mode is silent in both directions.
  const picker = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "components", "TranscriptionModelPicker.tsx"),
    "utf8"
  );
  assert.match(
    picker,
    /for \(const \{ id, modeKey \} of STREAMING_CAPABLE_PROVIDERS\)/,
    "the control must be derived from the same table the runtime routes on"
  );
  assert.equal(
    (picker.match(/key: "[a-z]+TranscriptionMode"/g) || []).length,
    0,
    "no provider should hand-write its own mode field any more"
  );
});

test("a provider with a live socket is declared streaming-capable", () => {
  // The invariant that spans the two files, and the one that actually catches a missing
  // entry. audioManager maps a provider to its streaming API
  // (STREAMING_PROVIDER_BY_TRANSCRIPTION_PROVIDER) — having one is what it means to be
  // able to stream. STREAMING_CAPABLE_PROVIDERS is what gives it a mode setting and,
  // now, a control in the UI.
  //
  // A provider in the first and not the second can stream but can never be told to: it
  // is routed to batch forever with no way to change it, which is how Meta shipped.
  const root = path.join(__dirname, "..", "..");
  const manager = fs.readFileSync(path.join(root, "src", "helpers", "audioManager.js"), "utf8");
  const config = fs.readFileSync(path.join(root, "src", "config", "multiTranscription.ts"), "utf8");

  const mapBody = manager.slice(
    manager.indexOf("const STREAMING_PROVIDER_BY_TRANSCRIPTION_PROVIDER = {"),
    manager.indexOf("};", manager.indexOf("const STREAMING_PROVIDER_BY_TRANSCRIPTION_PROVIDER = {"))
  );
  const wired = [...mapBody.matchAll(/^\s*([a-z-]+):\s*"/gm)].map((m) => m[1]);
  assert.ok(wired.length >= 3, `expected the socket map, parsed ${wired.length}`);

  const capable = [...config.matchAll(/\{ id: "([a-z-]+)", modeKey: "[A-Za-z]+" \}/g)].map(
    (m) => m[1]
  );

  const missing = wired.filter((id) => !capable.includes(id));
  assert.deepEqual(
    missing,
    [],
    `${missing.join(", ")} can stream but is absent from STREAMING_CAPABLE_PROVIDERS, so it has no mode setting and no control`
  );
});
