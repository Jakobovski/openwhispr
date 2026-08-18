const test = require("node:test");
const assert = require("node:assert/strict");

// OpenRouter joined the merge-provider picker after a real benchmark (2026-08-18): 15
// requests per candidate against the actual reconcile prompt, scored against objective
// per-case checks, not eyeballed. One candidate — nvidia/nemotron-3.5-lightning — was
// tested and deliberately left out: usually ~500ms but swung to 6-8s on several calls,
// and once returned a different test case's answer outright. This guards that the
// excluded model doesn't quietly get added back without someone re-deciding that.

const { RECONCILE_PROVIDER_IDS } = require("../../src/config/multiTranscription.ts");
const modelRegistryData = require("../../src/models/modelRegistryData.json");

test("openrouter is offered as a merge provider", () => {
  assert.ok(RECONCILE_PROVIDER_IDS.includes("openrouter"));
});

test("openrouter has a registry entry with the benchmarked models, and only those", () => {
  const provider = modelRegistryData.cloudProviders.find((p) => p.id === "openrouter");
  assert.ok(provider, "no openrouter entry in cloudProviders — the picker would show nothing");

  const ids = provider.models.map((m) => m.id).sort();
  assert.deepEqual(ids, [
    "anthropic/claude-haiku-4.5",
    "google/gemini-3.6-flash",
    "google/gemini-3.7-flash",
    "meta/muse-glimmer-30b",
    "thinkingmachines/inkling-small",
  ]);

  assert.ok(
    !ids.includes("nvidia/nemotron-3.5-lightning"),
    "nemotron-3.5-lightning was excluded for measured unreliability — re-add only after a deliberate re-benchmark"
  );
});

test("every openrouter model id is vendor-prefixed", () => {
  // getOpenAiApiConfig only recognises an OpenRouter model as such via the "/" in its
  // id (provider === "openrouter" && modelId.includes("/")) — an id without a vendor
  // prefix would silently fall through to the generic OpenAI-model-shape guessing
  // instead of the OpenRouter dialect.
  const provider = modelRegistryData.cloudProviders.find((p) => p.id === "openrouter");
  for (const model of provider.models) {
    assert.ok(model.id.includes("/"), `${model.id} is missing its vendor prefix`);
  }
});
