const test = require("node:test");
const assert = require("node:assert/strict");

// Node strips the types, so the TS config module loads directly.
const load = () => import("../../src/config/multiTranscription.ts");

const providers = (lanes) => lanes.map((lane) => lane.provider);

test("empty settings run the three slot defaults, in order", async () => {
  const {
    resolveMultiTranscriptionLanes,
    DEFAULT_MULTI_PROVIDER_A,
    DEFAULT_MULTI_PROVIDER_B,
    DEFAULT_MULTI_PROVIDER_C,
  } = await load();
  // Derived from the exported defaults rather than spelled out: what this asserts is
  // that a fresh install runs all three slots in slot order, which is the merge's
  // tie-break. Hardcoding the provider ids made this test fail every time the defaults
  // were retuned, which is a decision made elsewhere and not what this covers.
  assert.deepEqual(providers(resolveMultiTranscriptionLanes({})), [
    DEFAULT_MULTI_PROVIDER_A,
    DEFAULT_MULTI_PROVIDER_B,
    DEFAULT_MULTI_PROVIDER_C,
  ]);
});

test("a stored slot combined with a colliding default does not duplicate a provider", async () => {
  const { resolveMultiTranscriptionLanes, DEFAULT_MULTI_PROVIDER_B } = await load();
  // The real failure: slot A was stored as openai from the settings UI, slot B had no
  // stored value and its default had just been changed to openai. Every dictation went to
  // OpenAI twice and xAI never ran — visible only as "openai:ok, openai:ok, groq:ok" in a
  // log line.
  // Stores slot A as whatever slot B defaults to, so the collision is guaranteed
  // regardless of how the defaults are currently tuned.
  const collidingProvider = DEFAULT_MULTI_PROVIDER_B;
  const lanes = resolveMultiTranscriptionLanes({
    dualTranscriptionProviderA: collidingProvider,
  });

  assert.equal(providers(lanes)[0], collidingProvider, "the stored choice keeps slot A");
  assert.equal(providers(lanes).length, 3, "all three slots still run");
  assert.equal(new Set(providers(lanes)).size, 3, "no provider runs twice");
});

test("an explicitly chosen duplicate runs once rather than overriding the choice", async () => {
  const { resolveMultiTranscriptionLanes, DEFAULT_MULTI_PROVIDER_C } = await load();
  // Both A and B stored as groq by hand: honour the choice and drop the redundant call,
  // rather than substituting a provider the user did not ask for. Slot C is still on its
  // default, so it fills with whatever that is.
  const lanes = resolveMultiTranscriptionLanes({
    dualTranscriptionProviderA: "groq",
    dualTranscriptionProviderB: "groq",
  });

  assert.deepEqual(providers(lanes), ["groq", DEFAULT_MULTI_PROVIDER_C]);
});

test("a slot set to none runs nothing for that slot", async () => {
  const { resolveMultiTranscriptionLanes, NO_PROVIDER } = await load();
  const lanes = resolveMultiTranscriptionLanes({
    dualTranscriptionProviderA: "openai",
    dualTranscriptionProviderB: NO_PROVIDER,
    dualTranscriptionProviderC: NO_PROVIDER,
  });

  assert.deepEqual(providers(lanes), ["openai"]);
});

test("a substituted slot does not inherit the replaced provider's model", async () => {
  const { resolveMultiTranscriptionLanes } = await load();
  // Slot B holds a Groq model id but ends up running xAI, because slot A was stored as
  // openai and the collision pushed the default along. Carrying that id over would send
  // "whisper-large-v3-turbo" to xAI's endpoint, which fails every time.
  const lanes = resolveMultiTranscriptionLanes({
    dualTranscriptionProviderA: "openai",
    dualTranscriptionModelB: "whisper-large-v3-turbo",
  });

  const substituted = lanes.find((lane) => lane.provider === "xai");
  assert.equal(substituted.model, "grok-stt");
});

test("a stale model left by an earlier provider choice is healed", async () => {
  const { resolveMultiTranscriptionLanes } = await load();
  // Older builds did not clear the slot's model when its provider changed, so installs
  // exist with slot A on xAI still holding the OpenAI model it was picked with. The
  // settings picker only lists grok-stt for xAI, so the stored id was both unrunnable
  // and invisible.
  const lanes = resolveMultiTranscriptionLanes({
    dualTranscriptionProviderA: "xai",
    dualTranscriptionModelA: "gpt-transcribe",
  });

  assert.equal(lanes[0].model, "grok-stt");
});

test("a stored model is used for the slot that stored it", async () => {
  const { resolveMultiTranscriptionLanes } = await load();
  const lanes = resolveMultiTranscriptionLanes({
    dualTranscriptionProviderA: "openai",
    dualTranscriptionModelA: "whisper-1",
  });

  assert.equal(lanes[0].model, "whisper-1");
});

test("slot order is preserved, because it is the merge tie-break", async () => {
  const { resolveMultiTranscriptionLanes } = await load();
  const lanes = resolveMultiTranscriptionLanes({
    dualTranscriptionProviderA: "groq",
    dualTranscriptionProviderB: "xai",
    dualTranscriptionProviderC: "openai",
  });

  assert.deepEqual(providers(lanes), ["groq", "xai", "openai"]);
  assert.deepEqual(
    lanes.map((lane) => lane.slot),
    ["A", "B", "C"]
  );
});

test("a fresh install pairs each default slot with that provider's own model", async () => {
  // What matters is that no slot runs a model belonging to a different provider — the
  // failure that sent "whisper-large-v3-turbo" to xAI's endpoint. The specific default
  // providers are chosen elsewhere and asserted from the exported constants above, so
  // this derives the expected model from the provider table instead of restating it.
  const { resolveMultiTranscriptionLanes, MULTI_TRANSCRIPTION_MODELS } = await load();
  const lanes = resolveMultiTranscriptionLanes({});

  assert.equal(lanes.length, 3, "a fresh install runs all three slots");
  for (const lane of lanes) {
    assert.equal(
      lane.model,
      MULTI_TRANSCRIPTION_MODELS[lane.provider],
      `${lane.provider} was paired with ${lane.model}, which is not its own model`
    );
  }
});

test("every default lane model is a real id in the registry", async () => {
  // A default naming a model the provider does not serve fails at request time with a
  // 404 the user cannot act on — the way cleanup kept calling a retired Groq model.
  const { resolveMultiTranscriptionLanes } = await load();
  const registry = require("../../src/models/modelRegistryData.json");
  const known = new Map(
    (registry.transcriptionProviders || []).map((provider) => [
      provider.id,
      new Set((provider.models || []).map((model) => model.id)),
    ])
  );

  for (const lane of resolveMultiTranscriptionLanes({})) {
    assert.ok(
      known.get(lane.provider)?.has(lane.model),
      `${lane.provider} does not serve "${lane.model}"`
    );
  }
});
