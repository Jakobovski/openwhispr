const test = require("node:test");
const assert = require("node:assert/strict");

// The merge provider picker is deliberately two providers, in priority order:
// OpenRouter and xAI. Its models were chosen after real benchmarks, not eyeballed —
// 2026-08-18, 15 requests per candidate against the actual reconcile prompt scored on
// per-case checks, then 2026-08-19 for gpt-oss-120b over the production request shape.
// Everything else tried — Gemini 3.6/3.7 Flash, Muse Glimmer 30B,
// nvidia/nemotron-3.5-lightning — was cut for a measured reason, not left out by
// omission; see the comments in multiTranscription.ts.

const { RECONCILE_PROVIDER_IDS } = require("../../src/config/multiTranscription.ts");
const modelRegistryData = require("../../src/models/modelRegistryData.json");

test("the merge provider picker offers exactly openrouter and xai", () => {
  assert.deepEqual(RECONCILE_PROVIDER_IDS, ["openrouter", "xai"]);
});

test("openrouter has a registry entry with the kept models, fastest first", () => {
  const provider = modelRegistryData.cloudProviders.find((p) => p.id === "openrouter");
  assert.ok(provider, "no openrouter entry in cloudProviders — the picker would show nothing");

  // gpt-oss-120b first on purpose: resolveUsableModel heals a stored model the provider
  // no longer offers to the first entry, so the fastest measured one should be what a
  // stale setting lands on.
  const ids = provider.models.map((m) => m.id);
  assert.deepEqual(ids, [
    "openai/gpt-oss-120b",
    "thinkingmachines/inkling-small",
    "anthropic/claude-haiku-4.5",
  ]);

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
