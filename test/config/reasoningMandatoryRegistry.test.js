const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Which models refuse to have reasoning switched off is recorded per model in the
// registry, as `reasoningMandatory`. Declared rather than learned at runtime: the set is
// small, it belongs with everything else known about a model, and a reader can see it.
//
// It has to be per model and not per provider, because both behaviours coexist under
// openrouter — and it must never be assumed for a model nobody has checked, because
// nvidia/nemotron-3.5-lightning accepts a hard disable and *ignores* effort:minimal,
// burning its whole completion budget on reasoning tokens and returning nothing.
//
// Verified live against OpenRouter on 2026-08-19 (one call each, `reasoning:
// {enabled:false}`):
//   openai/gpt-oss-120b            REJECTS  "Reasoning is mandatory for this endpoint"
//   google/gemini-3.6-flash        REJECTS
//   google/gemini-3.7-flash        REJECTS
//   meta/muse-glimmer-30b          REJECTS
//   thinkingmachines/inkling-small accepts
//   anthropic/claude-haiku-4.5     accepts
//   nvidia/nemotron-3.5-lightning  accepts

const ROOT = path.join(__dirname, "..", "..");
const registry = require(path.join(ROOT, "src", "models", "modelRegistryData.json"));
const registrySource = fs.readFileSync(
  path.join(ROOT, "src", "models", "ModelRegistry.ts"),
  "utf8"
);
const suppression = fs.readFileSync(
  path.join(ROOT, "src", "services", "ai", "thinkingSuppression.ts"),
  "utf8"
);

/** Every (provider, model) pair the registry ships, so ids can be checked per provider. */
function cloudEntries() {
  const out = [];
  for (const provider of registry.cloudProviders) {
    for (const model of provider.models) out.push({ provider: provider.id, model });
  }
  return out;
}

// Confirmed to reject a hard disable. Checked only where the registry offers them, so
// re-adding one of the cut models without its flag fails here rather than silently
// costing a round trip on every call.
const KNOWN_REASONING_MANDATORY = [
  "openai/gpt-oss-120b",
  "google/gemini-3.6-flash",
  "google/gemini-3.7-flash",
  "meta/muse-glimmer-30b",
];

// Confirmed to accept a hard disable. Flagging any of these would weaken a request that
// works today — and for nemotron would break it outright.
const KNOWN_REASONING_OPTIONAL = [
  "thinkingmachines/inkling-small",
  "anthropic/claude-haiku-4.5",
  "nvidia/nemotron-3.5-lightning",
];

test("gpt-oss-120b under openrouter is flagged reasoningMandatory", () => {
  const entry = cloudEntries().find(
    (e) => e.provider === "openrouter" && e.model.id === "openai/gpt-oss-120b"
  );
  assert.ok(entry, "openrouter no longer offers gpt-oss-120b — has it been removed?");
  assert.equal(entry.model.reasoningMandatory, true);
});

test("every model confirmed to reject a hard disable carries the flag, wherever offered", () => {
  // Scoped to OpenRouter: the rejection is a property of the OpenRouter endpoint, and
  // the same id served by Groq is a different endpoint that behaves differently.
  const offered = cloudEntries().filter((e) => e.provider === "openrouter");
  let checked = 0;
  for (const id of KNOWN_REASONING_MANDATORY) {
    const entry = offered.find((e) => e.model.id === id);
    if (!entry) continue;
    checked += 1;
    assert.equal(
      entry.model.reasoningMandatory,
      true,
      `${id} is known to reject a hard disable but is not flagged reasoningMandatory`
    );
  }
  assert.ok(checked > 0, "none of the known models are offered — has the list gone stale?");
});

test("no model confirmed to accept a hard disable is flagged", () => {
  for (const { provider, model } of cloudEntries()) {
    if (!KNOWN_REASONING_OPTIONAL.includes(model.id)) continue;
    assert.notEqual(
      model.reasoningMandatory,
      true,
      `${provider}/${model.id} accepts a hard disable; flagging it weakens a working request`
    );
  }
});

test("the flag is only ever true, never a string or other truthy value", () => {
  // It is read as a plain boolean and forwarded into the request shape, so "false" or
  // 0 would silently take the wrong branch.
  for (const { provider, model } of cloudEntries()) {
    if (!("reasoningMandatory" in model)) continue;
    assert.equal(
      typeof model.reasoningMandatory,
      "boolean",
      `${provider}/${model.id} has a non-boolean reasoningMandatory`
    );
  }
});

test("the same model id under two providers resolves to the right provider's entry", () => {
  // The bug this exists for: openai/gpt-oss-120b ships from BOTH groq and openrouter,
  // groq is listed first, and getCloudModel scanned by id alone — so an OpenRouter call
  // read groq's entry and never saw reasoningMandatory at all. Nothing failed; the
  // request was just silently wrong on every call.
  const shared = cloudEntries().filter((e) => e.model.id === "openai/gpt-oss-120b");
  assert.ok(
    shared.length > 1,
    "gpt-oss-120b is no longer shared across providers — this guard needs a new subject"
  );
  assert.ok(
    shared.some((e) => e.provider === "groq"),
    "expected groq to still offer it, which is what makes the shadowing possible"
  );

  // getCloudModel must accept a provider hint, and the suppression path must pass one.
  assert.match(
    registrySource,
    /export function getCloudModel\(\s*modelId: string,\s*providerId\?: string\s*\)/,
    "getCloudModel must take an optional provider so a shared id can be disambiguated"
  );
  assert.match(
    suppression,
    /getCloudModel\(model,\s*provider\)/,
    "the suppression path must look the model up under the provider being called"
  );
});
