const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildProviderModelIndex,
  resolveUsableModel,
} = require("../../src/helpers/modelAvailability.js");

const PROVIDERS = [
  {
    id: "groq",
    models: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }],
  },
  { id: "openai", models: [{ id: "gpt-5.5" }, { id: "gpt-5-mini" }] },
  { id: "emptyProvider", models: [] },
];

const index = buildProviderModelIndex(PROVIDERS);

test("a model still on offer is returned untouched", () => {
  assert.equal(resolveUsableModel("groq", "openai/gpt-oss-20b", index), "openai/gpt-oss-20b");
});

test("a retired model falls back to the provider's first model", () => {
  // The real case: Groq shut down qwen/qwen3-32b on 2026-07-17.
  assert.equal(resolveUsableModel("groq", "qwen/qwen3-32b", index), "openai/gpt-oss-120b");
});

test("the substitute comes from the same provider, not another one", () => {
  assert.equal(resolveUsableModel("openai", "qwen/qwen3-32b", index), "gpt-5.5");
});

test("an unconfigured scope is left unconfigured", () => {
  // Inventing a model here would silently switch on a scope the user never set up.
  assert.equal(resolveUsableModel("groq", "", index), "");
  assert.equal(resolveUsableModel("groq", undefined, index), undefined);
});

test("a missing provider is left alone", () => {
  assert.equal(resolveUsableModel("", "some-model", index), "some-model");
});

test("providers with runtime-fetched model lists are never rewritten", () => {
  // The static registry does not know what these currently offer, so any
  // substitution would be a guess that overwrites a valid selection.
  for (const provider of ["custom", "openrouter", "tinfoil"]) {
    assert.equal(
      resolveUsableModel(provider, "whatever-they-picked", index),
      "whatever-they-picked"
    );
  }
});

test("unknown providers keep their model", () => {
  // Local, enterprise, and LAN models are not in the cloud registry.
  assert.equal(resolveUsableModel("llama", "qwen3-32b-q4_k_m", index), "qwen3-32b-q4_k_m");
  assert.equal(resolveUsableModel("emptyProvider", "anything", index), "anything");
});

test("the index tolerates malformed input", () => {
  assert.equal(buildProviderModelIndex(undefined).size, 0);
  assert.equal(buildProviderModelIndex([{ id: "x" }]).get("x").length, 0);
  assert.equal(resolveUsableModel("groq", "m", undefined), "m");
});

test("the shipped registry no longer offers the models Groq retired", () => {
  // Guards the fix: these 404 on Groq, and being first in the list meant
  // selectDefaultModelForProvider auto-assigned one of them.
  const registry = require("../../src/models/modelRegistryData.json");
  const groq = (registry.cloudProviders || []).find((p) => p.id === "groq");
  const ids = (groq?.models || []).map((m) => m.id);

  assert.ok(ids.length > 0, "groq provider still present");
  for (const dead of ["qwen/qwen3-32b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"]) {
    assert.ok(!ids.includes(dead), `${dead} was shut down by Groq and must not be offered`);
  }
  assert.equal(ids[0], "openai/gpt-oss-120b", "the auto-picked default is a live model");
});
