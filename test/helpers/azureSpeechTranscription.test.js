const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDefinition,
  buildUrl,
  normalizeEndpoint,
  MAX_PHRASES,
  MAX_PHRASE_LENGTH,
} = require("../../src/helpers/azureSpeechTranscription");

// The `definition` part carries every rule in this integration, and each one was learned
// from the live API rejecting something. The transport around it is ordinary.

test("the portal's project URL is converted to the Speech host", () => {
  // What the Azure portal displays is a Foundry project URL, and the Speech REST API
  // does not live there — pasting it verbatim produced a request to the wrong host.
  assert.equal(
    normalizeEndpoint(
      "https://zoharj-1127-resource.services.ai.azure.com/api/projects/zoharj-1127"
    ),
    "https://zoharj-1127-resource.cognitiveservices.azure.com"
  );
  // The resource host itself is passed through, with or without a scheme or a trailing slash.
  assert.equal(
    normalizeEndpoint("zoharj-1127-resource.cognitiveservices.azure.com"),
    "https://zoharj-1127-resource.cognitiveservices.azure.com"
  );
  assert.equal(normalizeEndpoint(""), "");
  assert.equal(normalizeEndpoint(null), "");
});

test("the url carries the api version the endpoint requires", () => {
  assert.equal(
    buildUrl("https://x.cognitiveservices.azure.com/"),
    "https://x.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15"
  );
  assert.equal(buildUrl(""), null);
});

test("enhanced mode is always requested, since that is what selects the model", () => {
  const d = buildDefinition({});
  assert.deepEqual(d.enhancedMode, {
    enabled: true,
    model: "MAI-Transcribe-2",
    // Explicit, because v2 flipped the default. v1.5 returned a readability-optimised
    // transcript unless asked for verbatim; v2 returns verbatim unless asked for clean,
    // so leaving this unset would quietly start pasting "um" and "uh" into dictations
    // that never had them.
    modelOptions: { transcribeStyle: "clean" },
  });
});

test("an absent locale means multilingual rather than a guess", () => {
  // Azure rejects a bare "en", and the model's default is multilingual — so when the
  // user has not chosen a language the key is omitted rather than filled in.
  assert.equal(buildDefinition({}).locales, undefined);
  assert.deepEqual(buildDefinition({ locale: "en-US" }).locales, ["en-US"]);
});

test("phrases are deduplicated case-insensitively", () => {
  // The same term routinely arrives from both the custom dictionary and the screen.
  const d = buildDefinition({ phrases: ["OpenWhispr", "openwhispr", "  OpenWhispr  ", "Sinead"] });
  assert.deepEqual(d.phraseList.phrases, ["OpenWhispr", "Sinead"]);
});

test("blank and non-string entries are dropped without breaking the list", () => {
  const d = buildDefinition({ phrases: ["Kubernetes", "", "   ", null, 42, undefined, "Grafana"] });
  assert.deepEqual(d.phraseList.phrases, ["Kubernetes", "Grafana"]);
});

test("no phrases means no phraseList key at all", () => {
  // An empty list is not the same as no list; sending one would be a request to bias
  // recognition toward nothing.
  assert.equal(buildDefinition({ phrases: [] }).phraseList, undefined);
  assert.equal(buildDefinition({ phrases: ["", "  "] }).phraseList, undefined);
});

test("the list is capped, keeping the highest-priority entries", () => {
  // Order is the priority order the caller assembled — dictionary first, then screen
  // terms — so the cap must take from the front rather than sample.
  const phrases = Array.from({ length: MAX_PHRASES + 50 }, (_, i) => `term${i}`);
  const kept = buildDefinition({ phrases }).phraseList.phrases;

  assert.equal(kept.length, MAX_PHRASES);
  assert.equal(kept[0], "term0");
  assert.equal(kept.at(-1), `term${MAX_PHRASES - 1}`);
});

test("an over-long phrase is trimmed rather than dropped", () => {
  // A phrase matches as a whole entry, so an essay will never match — but it may well
  // start with the term that mattered.
  const long = "Supercalifragilistic".repeat(20);
  const kept = buildDefinition({ phrases: [long] }).phraseList.phrases;

  assert.equal(kept[0].length, MAX_PHRASE_LENGTH);
  assert.ok(long.startsWith(kept[0]));
});

test("the MAI model is v2 everywhere, with no v1.5 left behind", () => {
  // The id is validated by both routes, so a wrong one is not a silent downgrade — Azure
  // answers 400 "Requested MAI transcription model ... is not supported" and OpenRouter
  // answers "Model ... does not exist". Both were checked against the live APIs when this
  // moved to v2: mai-transcribe-2 and microsoft/mai-transcribe-2 transcribe, while
  // mai-transcribe-v2 and mai-transcribe-2.0 are rejected.
  //
  // Scanned across the source rather than asserted at one call site, because the id
  // appears in the lane table, the model registry and this client's default, and a
  // half-finished rename leaves two lanes on different models.
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..", "..");
  const files = [
    ["src", "config", "multiTranscription.ts"],
    ["src", "models", "modelRegistryData.json"],
    ["src", "helpers", "azureSpeechTranscription.js"],
    ["src", "helpers", "audioManager.js"],
  ];

  const stale = [];
  for (const parts of files) {
    const text = fs.readFileSync(path.join(root, ...parts), "utf8");
    if (/mai-transcribe-1\.5|MAI-Transcribe 1\.5/.test(text)) stale.push(parts.join("/"));
  }
  assert.deepEqual(stale, [], "v1.5 is no longer supported and must not be referenced");

  const lanes = fs.readFileSync(path.join(root, "src", "config", "multiTranscription.ts"), "utf8");
  assert.match(lanes, /model: "microsoft\/mai-transcribe-2"/, "the OpenRouter lane must be v2");
  assert.match(lanes, /model: "MAI-Transcribe-2"/, "the Azure lane must be v2");
});
