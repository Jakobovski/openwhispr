const test = require("node:test");
const assert = require("node:assert/strict");

// The merge provider picker is deliberately three options, in priority order: Inkling
// Small and Haiku 4.5 (both via OpenRouter, the default and its equally-accurate
// runner-up) and xAI (the original default). Chosen after a real benchmark
// (2026-08-18): 15 requests per candidate against the actual reconcile prompt, scored
// against objective per-case checks, not eyeballed. Everything else tried —
// Gemini 3.6/3.7 Flash, Muse Glimmer 30B, nvidia/nemotron-3.5-lightning — was cut for a
// measured reason, not left out by omission; see the comments in multiTranscription.ts.

const { RECONCILE_PROVIDER_IDS } = require("../../src/config/multiTranscription.ts");
const modelRegistryData = require("../../src/models/modelRegistryData.json");

test("the merge provider picker offers exactly openrouter and xai", () => {
  assert.deepEqual(RECONCILE_PROVIDER_IDS, ["openrouter", "xai"]);
});

test("openrouter has a registry entry with exactly the two kept models, Inkling first", () => {
  const provider = modelRegistryData.cloudProviders.find((p) => p.id === "openrouter");
  assert.ok(provider, "no openrouter entry in cloudProviders — the picker would show nothing");

  const ids = provider.models.map((m) => m.id);
  assert.deepEqual(ids, ["thinkingmachines/inkling-small", "anthropic/claude-haiku-4.5"]);

  for (const cut of [
    "google/gemini-3.6-flash",
    "google/gemini-3.7-flash",
    "meta/muse-glimmer-30b",
    "nvidia/nemotron-3.5-lightning",
  ]) {
    assert.ok(!ids.includes(cut), `${cut} was deliberately cut — re-add only after a re-benchmark`);
  }
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
