const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Every OpenRouter chat completion this app sends carries these routing preferences.
// One factory rather than per-model config, because OpenRouter can route the same
// model id across several backend providers with very different speed and
// reliability — confirmed live for nvidia/nemotron-3.5-lightning, served by three
// backends whose p90 latency ranged from 633ms to 22 seconds — and a model added to
// the registry tomorrow gets this automatically rather than needing its own entry.

const {
  buildOpenRouterProviderRouting,
  isReasoningMandatoryError,
  fallbackReasoningRequest,
  OPENROUTER_MAX_LATENCY_P90_SECONDS,
  OPENROUTER_MIN_THROUGHPUT_P90_TPS,
  PINNED_PROVIDER_MODEL_IDS,
  isReasoningMandatoryModel,
  rememberReasoningMandatory,
} = require("../../src/services/ai/openrouterRouting.ts");
const modelRegistryData = require("../../src/models/modelRegistryData.json");

test("the routing object matches OpenRouter's documented field names and shape", () => {
  // preferred_max_latency and preferred_min_throughput take a percentile object
  // ({ p90: ... }), not a bare number — a plain number is silently invalid per
  // OpenRouter's own docs, which is exactly the kind of mistake worth pinning.
  const routing = buildOpenRouterProviderRouting();
  assert.deepEqual(routing, {
    sort: "throughput",
    preferred_max_latency: { p90: OPENROUTER_MAX_LATENCY_P90_SECONDS },
    preferred_min_throughput: { p90: OPENROUTER_MIN_THROUGHPUT_P90_TPS },
  });
});

test("an unpinned model gets the soft preferences, pinned or not-passed alike", () => {
  // The defaults must not depend on being called with a model id: every model that
  // isn't explicitly pinned, and a call that passes nothing at all, get the same thing.
  assert.deepEqual(
    buildOpenRouterProviderRouting("anthropic/claude-haiku-4.5"),
    buildOpenRouterProviderRouting()
  );
  assert.deepEqual(
    buildOpenRouterProviderRouting("some/model-added-tomorrow"),
    buildOpenRouterProviderRouting()
  );
});

test("gpt-oss-120b is hard-pinned to Cerebras, with no soft preferences alongside", () => {
  // `only` is a hard restriction where sort/preferred_* are explicitly soft — the
  // whole reason to pin is that this model is served by 20 backends and only Cerebras
  // is fast. Soft preferences beside `only` would imply it could still route around it.
  const routing = buildOpenRouterProviderRouting("openai/gpt-oss-120b");
  assert.deepEqual(routing, { only: ["cerebras"] });
});

test("every pinned model id is one the registry actually offers", () => {
  // A pin keyed on a model id the registry no longer has is dead config that still
  // reads as though it does something.
  //
  // This has to iterate the *pins* and look each one up in the registry, not the other
  // way round. Deriving the pinned set by probing the factory with registry ids was the
  // first attempt and it was vacuous: a pin for a model absent from the registry is
  // never probed, so the one failure the test is named for passed cleanly.
  const openrouter = modelRegistryData.cloudProviders.find((p) => p.id === "openrouter");
  const offered = openrouter.models.map((m) => m.id);

  assert.ok(PINNED_PROVIDER_MODEL_IDS.length > 0, "no pins at all — has the table moved?");
  for (const id of PINNED_PROVIDER_MODEL_IDS) {
    assert.ok(offered.includes(id), `${id} is pinned but not offered by the registry`);
  }
});

test("the thresholds are the values asked for: 1000ms and 80 t/s at p90", () => {
  // preferred_max_latency is in seconds per OpenRouter's units, not milliseconds —
  // 1000ms is 1, not 1000. Getting that wrong would silently ask for a threshold
  // 1000x looser than intended and nothing would ever fail to warn about it.
  assert.equal(OPENROUTER_MAX_LATENCY_P90_SECONDS, 1);
  assert.equal(OPENROUTER_MIN_THROUGHPUT_P90_TPS, 80);
});

test("a model added to the registry needs no routing config of its own", () => {
  // Static check that the factory is actually wired in generically (gated only on
  // "is this an OpenRouter call"), not called out per model id — the whole point
  // of a factory is that adding openrouter/some-new-model to modelRegistryData.json
  // is the entire change.
  const openaiClient = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "services", "ai", "inferenceProviders", "openai.ts"),
    "utf8"
  );
  assert.match(
    openaiClient,
    /if \(isOpenRouter\) \{\s*\n\s*requestBody\.provider = buildOpenRouterProviderRouting\(model\);/,
    "the routing factory must be applied unconditionally for every OpenRouter call"
  );
  assert.doesNotMatch(
    openaiClient,
    /model\.includes\(.*openrouter.*\).*provider/is,
    "routing looks like it's gated on a specific model id rather than applied generically"
  );
  // Passing the model id is how a pin is looked up, but the call site must stay
  // model-agnostic: the moment openai.ts names a model to decide routing, adding the
  // next one becomes a two-file change again.
  assert.doesNotMatch(
    openaiClient,
    /requestBody\.provider = [^;]*(cerebras|gpt-oss)/i,
    "the call site must not name a specific model or backend when setting routing"
  );
});

test("the reasoning-mandatory rejection is recognised by its actual wording", () => {
  assert.equal(
    isReasoningMandatoryError("Reasoning is mandatory for this endpoint and cannot be disabled."),
    true
  );
  assert.equal(isReasoningMandatoryError("some other 400"), false);
  assert.equal(isReasoningMandatoryError(null), false);
  assert.equal(isReasoningMandatoryError(undefined), false);
  assert.equal(isReasoningMandatoryError(""), false);
});

test("the fallback request is the softer one, not another hard disable", () => {
  // If this ever became { enabled: false } again, the retry would fail exactly the
  // same way the first attempt did, forever.
  assert.deepEqual(fallbackReasoningRequest(), { effort: "minimal" });
});

test("openai.ts retries a rejected reasoning disable rather than giving up", () => {
  const openaiClient = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "services", "ai", "inferenceProviders", "openai.ts"),
    "utf8"
  );
  assert.match(openaiClient, /isReasoningMandatoryError\(/);
  assert.match(openaiClient, /requestBody\.reasoning = fallbackReasoningRequest\(\);/);
  // The retry has to happen before the generic error-handling path, or the mandatory-
  // reasoning rejection gets thrown as a normal API error before it's ever caught.
  const retryAt = openaiClient.indexOf("isReasoningMandatoryError(");
  const genericErrorAt = openaiClient.indexOf("const errorData = await res.json()");
  assert.ok(retryAt > 0 && genericErrorAt > 0 && retryAt < genericErrorAt);
});

// --- the learned reasoning-mandatory cache ---
//
// Why learned and not declared: a static list of models that reject a hard reasoning
// disable can only ever be behind whatever OpenRouter has added since it was written,
// which is why the retry deliberately has none. But that left every call to such a
// model paying for a rejected request first — 67ms of a 189ms merge for gpt-oss-120b,
// measured, and that merge sits in the paste path. Remembering what the rejection
// already told us costs nothing and cannot be wrong about a model it has not seen.

test("a model is not assumed reasoning-mandatory until it has actually said so", () => {
  // The property that makes this safe to do at all: no model is pre-declared, so a
  // model that accepts a hard disable is never wrongly downgraded to effort:minimal
  // (the nemotron failure mode — it accepts {enabled:false} and *ignores* minimal,
  // spending its whole completion budget on reasoning tokens).
  assert.equal(isReasoningMandatoryModel("some/never-seen-model"), false);
});

test("a model that rejected once is remembered, so later calls skip the doomed attempt", () => {
  const model = "test/remembered-model";
  assert.equal(isReasoningMandatoryModel(model), false);
  rememberReasoningMandatory(model);
  assert.equal(isReasoningMandatoryModel(model), true);
});

test("remembering is idempotent and does not affect other models", () => {
  rememberReasoningMandatory("test/model-a");
  rememberReasoningMandatory("test/model-a");
  assert.equal(isReasoningMandatoryModel("test/model-a"), true);
  assert.equal(isReasoningMandatoryModel("test/model-b"), false);
});

test("openai.ts records the rejection and skips the hard disable on later calls", () => {
  const openaiClient = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "services", "ai", "inferenceProviders", "openai.ts"),
    "utf8"
  );

  // Both halves are required. Recording without skipping wastes the round trip forever;
  // skipping without recording never learns anything and is dead code.
  assert.match(
    openaiClient,
    /rememberReasoningMandatory\(model\);/,
    "the rejection must be recorded, or the next call pays for it again"
  );
  assert.match(
    openaiClient,
    /isReasoningMandatoryModel\(model\)\)\s*\{\s*\n\s*requestBody\.reasoning = fallbackReasoningRequest\(\);/,
    "a known reasoning-mandatory model must skip straight to the softer request"
  );

  // The skip has to be applied after suppression set the hard disable, or it is
  // overwritten by it and silently does nothing.
  const suppressionAt = openaiClient.indexOf("applyThinkingSuppression(requestBody");
  const skipAt = openaiClient.indexOf("isReasoningMandatoryModel(model)");
  assert.ok(suppressionAt > 0 && skipAt > suppressionAt, "the skip must come after suppression");
});
