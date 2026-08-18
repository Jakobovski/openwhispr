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
} = require("../../src/services/ai/openrouterRouting.ts");

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
    /if \(isOpenRouter\) \{\s*\n\s*requestBody\.provider = buildOpenRouterProviderRouting\(\);/,
    "the routing factory must be applied unconditionally for every OpenRouter call"
  );
  assert.doesNotMatch(
    openaiClient,
    /model\.includes\(.*openrouter.*\).*provider/is,
    "routing looks like it's gated on a specific model id rather than applied generically"
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
