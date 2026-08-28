const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const G = require("../../src/utils/geminiTranscribe.js");

// Every expectation here was confirmed against the live API on 2026-08-28. The endpoint
// rejects unknown fields with a 400, so a wrong key is not a silently ignored option —
// it is a failed dictation. That is what makes these worth pinning as tests rather than
// trusting to a comment.

test("batch config sits at generation_config.transcription_config", () => {
  // The live socket rejects this exact path, and the batch endpoint rejects the live
  // one. Getting them backwards is the single most likely mistake in this file.
  const body = G.buildBatchRequest({ audioBase64: "AAAA", language: "en" });
  assert.ok(body.generation_config?.transcription_config, "config is not where batch wants it");
  assert.equal(body.generation_config.transcription_config.mode, "smart");
  assert.ok(
    !("input_audio_transcription" in body),
    "input_audio_transcription is the live location and 400s here"
  );
});

test("live config sits at setup.input_audio_transcription", () => {
  const message = G.buildLiveSetup({ language: "en" });
  assert.ok(message.setup?.input_audio_transcription, "config is not where the socket wants it");
  assert.ok(
    !message.setup.generation_config,
    "generation_config.transcription_config is a 1007 close on the socket"
  );
});

test("field names are snake_case, which is the only casing accepted", () => {
  // The API answers camelCase with `Unknown parameter 'languageCodes'. Did you mean
  // 'language_codes'?` — so this is not a style preference.
  const config = G.buildTranscriptionConfig({
    language: "en",
    vocabulary: ["OpenWhispr"],
  });
  assert.deepEqual(Object.keys(config).sort(), ["custom_vocabulary", "language_codes", "mode"]);
});

test("smart mode is the default, since there are no separate formatting switches", () => {
  // enable_automatic_punctuation, text_normalization, formatting and enable_formatting
  // are all rejected as unknown parameters. mode: "smart" *is* the de-fill-and-format
  // feature, so defaulting to it is what turns formatting and normalization on.
  assert.equal(G.buildTranscriptionConfig().mode, "smart");
  assert.equal(G.DEFAULT_TRANSCRIPTION_MODE, "smart");
  assert.equal(G.buildTranscriptionConfig({ mode: "verbatim" }).mode, "verbatim");
});

test("a known language becomes a hint, and auto omits it entirely", () => {
  // Bare codes are accepted, so there is no locale mapping to do — "en" works, and
  // "en-US" is not required.
  assert.deepEqual(G.buildTranscriptionConfig({ language: "en" }).language_codes, ["en"]);
  assert.deepEqual(G.buildTranscriptionConfig({ language: "zh" }).language_codes, ["zh"]);

  // A wrong hint is worse than none, and "auto" is the app saying it does not know.
  for (const language of ["auto", "", null, undefined]) {
    assert.ok(
      !("language_codes" in G.buildTranscriptionConfig({ language })),
      `language ${JSON.stringify(language)} must not become a hint`
    );
  }
});

test("vocabulary is capped at the 1000 the server actually enforces", () => {
  // 1001+ returns 400 "custom_vocabulary cannot contain more than 1000 entries", so
  // trimming here is the difference between a working dictation and a failed one.
  const terms = Array.from({ length: 1500 }, (_, i) => `term${i}`);
  const config = G.buildTranscriptionConfig({ vocabulary: terms });
  assert.equal(config.custom_vocabulary.length, G.GEMINI_VOCABULARY_LIMIT);
  assert.equal(G.GEMINI_VOCABULARY_LIMIT, 1000);
  // The head is kept, not a random slice: the dictionary is ordered deliberately, with
  // the user's curated words ahead of terms scraped off the screen.
  assert.equal(config.custom_vocabulary[0], "term0");
});

test("vocabulary is trimmed, de-duplicated case-insensitively, and keeps its casing", () => {
  // The casing is the whole point for a term like OpenWhispr, and the list is built from
  // two sources that routinely supply the same word.
  const config = G.buildTranscriptionConfig({
    vocabulary: ["  OpenWhispr  ", "openwhispr", "OPENWHISPR", "", "   ", "Sinead", null, 42],
  });
  assert.deepEqual(config.custom_vocabulary, ["OpenWhispr", "Sinead"]);
});

test("an empty vocabulary is omitted rather than sent as an empty array", () => {
  for (const vocabulary of [[], null, undefined, ["", "  "]]) {
    assert.ok(
      !("custom_vocabulary" in G.buildTranscriptionConfig({ vocabulary })),
      `${JSON.stringify(vocabulary)} should not produce a key`
    );
  }
});

test("the batch response transcript is read from the model_output step", () => {
  // Real response shape, copied from a live call.
  const response = {
    status: "completed",
    steps: [
      { type: "model_output", content: [{ text: "Let's ship the build.", type: "text" }] },
    ],
    model: "gemini-3.5-transcribe",
  };
  assert.equal(G.parseBatchResponse(response), "Let's ship the build.");
});

test("a batch response with no transcript yields an empty string, not a throw", () => {
  // An empty answer is a normal provider outcome the fan-out already handles; throwing
  // would turn it into a lane failure and lose the other lanes' work.
  for (const response of [{}, null, { steps: [] }, { steps: [{ type: "other" }] }]) {
    assert.equal(G.parseBatchResponse(response), "");
  }
});

test("live messages are classified into setup, partial, final and done", () => {
  // Shapes taken verbatim from a live socket session.
  assert.equal(G.parseLiveMessage({ setupComplete: {} }).kind, "setup");

  const partial = G.parseLiveMessage({
    serverContent: { interimInputTranscription: { text: "Let's ship the" } },
  });
  assert.deepEqual(partial, { kind: "partial", text: "Let's ship the" });

  const final = G.parseLiveMessage({
    serverContent: { inputTranscription: { text: "Let's ship the build." } },
  });
  assert.deepEqual(final, { kind: "final", text: "Let's ship the build." });

  assert.equal(G.parseLiveMessage({ serverContent: { generationComplete: true } }).kind, "done");
  assert.equal(G.parseLiveMessage({ serverContent: {} }).kind, "other");
  assert.equal(G.parseLiveMessage(null).kind, "other");
});

test("a partial is a full replacement, not a delta to append", () => {
  // Each interim carries the whole utterance so far. A consumer that concatenated them
  // would render "Let'sLet's shipLet's ship the" — so this documents the contract the
  // preview depends on.
  const texts = ["Let's ship", "Let's ship the", "Let's ship the OpenWhispr"];
  const parsed = texts.map((text) =>
    G.parseLiveMessage({ serverContent: { interimInputTranscription: { text } } })
  );
  assert.ok(parsed.every((p) => p.kind === "partial"));
  for (let i = 1; i < parsed.length; i++) {
    assert.ok(
      parsed[i].text.startsWith(parsed[i - 1].text),
      "each partial should extend the previous one, which is why it replaces rather than appends"
    );
  }
});

test("the live model id is fully qualified, which the socket requires", () => {
  assert.equal(
    G.buildLiveSetup().setup.model,
    `models/${G.GEMINI_TRANSCRIBE_LIVE_MODEL}`,
    "the socket rejects a bare model id"
  );
  // Already-qualified input must not be doubled into models/models/...
  assert.equal(
    G.buildLiveSetup({ model: "models/gemini-3.5-transcribe-live" }).setup.model,
    "models/gemini-3.5-transcribe-live"
  );
});

test("live audio chunks declare the PCM rate the recorder produces", () => {
  const chunk = G.buildLiveAudioChunk("AAAA");
  assert.deepEqual(chunk, {
    realtime_input: { audio: { mime_type: "audio/pcm;rate=16000", data: "AAAA" } },
  });
  assert.deepEqual(G.buildLiveAudioStreamEnd(), { realtime_input: { audio_stream_end: true } });
});

test("the live url carries the key in the query string", () => {
  // The Live socket has no header stage, so the key cannot be sent as one.
  const url = G.buildLiveUrl("abc/123");
  assert.ok(url.startsWith("wss://"), "must be a websocket url");
  assert.ok(url.includes("key=abc%2F123"), "the key must be present and encoded");
});

// --- wiring ---

const audioManager = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "helpers", "audioManager.js"),
  "utf8"
);

test("the gemini request sends dictionary plus screen terms at the full 1000", () => {
  // The point of this provider for this app: it accepts the vocabulary at five times
  // Azure's cap, so passing the shared 200-term limit would throw away 800 terms of the
  // speaker's own words for no reason.
  // Sliced from the shared builder rather than the lane branch: the lane now delegates
  // to transcribeOneShotWithProvider, which both it and the single-provider path call.
  const start = audioManager.indexOf("async transcribeOneShotWithProvider(");
  assert.ok(start > 0, "the shared one-shot builder is missing");
  const branch = audioManager.slice(start, start + 2400);

  assert.match(
    branch,
    /getProviderTerms\("gemini"\)/,
    "must get its terms from the shared shaper, which applies gemini's 1000-term cap"
  );
  assert.match(branch, /buildGeminiBatchRequest\(/, "must build the request with the shared module");
  assert.match(
    branch,
    /parseGeminiBatchResponse\(/,
    "must parse with the shared module rather than reaching into the response shape"
  );
});

test("the gemini request posts to interactions, not generateContent", () => {
  const start = audioManager.indexOf("async transcribeOneShotWithProvider(");
  const branch = audioManager.slice(start, start + 2400);
  assert.match(branch, /GEMINI_INTERACTIONS_PATH/, "must use the interactions endpoint");

  // Comments stripped first: the branch explains in prose *why* generateContent is not
  // used, and matching that comment is how this assertion passed vacuously at first.
  const code = branch.replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    code,
    /generateContent/,
    "generateContent is advertised for this model but returns empty text"
  );
});
