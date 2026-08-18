const test = require("node:test");
const assert = require("node:assert/strict");

// xAI's model list in the merge provider picker drops Grok 4.3 and keeps the other
// two, at the user's request — but the request itself was informed by a measurement:
// verified live that Grok 4.3 barely responds to the `reasoning_effort: "low"` hint
// sent automatically whenever the merge runs (331 → 329 reasoning tokens, no latency
// change), where the same hint substantially helps Grok 4.5 (324 → 86 reasoning
// tokens, 6.1s → 2.6s). See the comment above RECONCILE_PROVIDER_IDS in
// multiTranscription.ts for the full numbers, including the non-reasoning variant's.

const modelRegistryData = require("../../src/models/modelRegistryData.json");

test("xai offers grok-4.5 and the non-reasoning variant, and not grok-4.3", () => {
  const provider = modelRegistryData.cloudProviders.find((p) => p.id === "xai");
  assert.ok(provider, "no xai entry in cloudProviders — the picker would show nothing");

  const ids = provider.models.map((m) => m.id);
  assert.deepEqual(ids, ["grok-4.5", "grok-4.20-0309-non-reasoning"]);

  assert.ok(
    !ids.includes("grok-4.3"),
    "grok-4.3 was deliberately cut — it barely responds to the low-reasoning hint — re-add only after reconsidering"
  );
});

test("grok-4.5 is thinking-capable, or the reasoning_effort hint has nothing to do", () => {
  // The whole reason grok-4.5 is worth keeping alongside the non-reasoning variant:
  // it responds to being told to reason less. A model already marked non-reasoning
  // would make that dialect a no-op, same as the non-reasoning variant itself.
  const provider = modelRegistryData.cloudProviders.find((p) => p.id === "xai");
  const grok45 = provider.models.find((m) => m.id === "grok-4.5");
  assert.ok(grok45, "grok-4.5 must still be present to make this assertion meaningful");
  assert.equal(grok45.supportsThinking, true);
});

test("the non-reasoning variant is marked as such, or suppressThinking would try anyway", () => {
  // applyThinkingSuppression skips calling suppressThinking() when a model's own
  // supportsThinking is false — matches what the live API does when asked anyway: it
  // rejects reasoning_effort for this exact model outright ("does not support
  // parameter reasoningEffort"), confirmed while benchmarking merge providers.
  const provider = modelRegistryData.cloudProviders.find((p) => p.id === "xai");
  const nonReasoning = provider.models.find((m) => m.id === "grok-4.20-0309-non-reasoning");
  assert.ok(nonReasoning, "the non-reasoning variant must still be present");
  assert.equal(nonReasoning.supportsThinking, false);
});
