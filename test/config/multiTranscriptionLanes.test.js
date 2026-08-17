const test = require("node:test");
const assert = require("node:assert/strict");

// Node strips the types, so the TS config module loads directly.
const load = () => import("../../src/config/dualTranscription.ts");

const providers = (lanes) => lanes.map((lane) => lane.provider);

test("empty settings run the three slot defaults, in order", async () => {
  const { resolveMultiTranscriptionLanes } = await load();
  assert.deepEqual(providers(resolveMultiTranscriptionLanes({})), ["xai", "openai", "openrouter"]);
});

test("a stored slot combined with a colliding default does not duplicate a provider", async () => {
  const { resolveMultiTranscriptionLanes } = await load();
  // The real failure: slot A was stored as openai from the settings UI, slot B had no
  // stored value and its default had just been changed to openai. Every dictation went to
  // OpenAI twice and xAI never ran — visible only as "openai:ok, openai:ok, groq:ok" in a
  // log line.
  const lanes = resolveMultiTranscriptionLanes({ dualTranscriptionProviderA: "openai" });

  assert.deepEqual(providers(lanes), ["openai", "xai", "openrouter"]);
  assert.equal(new Set(providers(lanes)).size, 3, "no provider runs twice");
});

test("an explicitly chosen duplicate runs once rather than overriding the choice", async () => {
  const { resolveMultiTranscriptionLanes } = await load();
  // Both A and B stored as groq by hand: honour the choice and drop the redundant call,
  // rather than substituting a provider the user did not ask for. Slot C is still on its
  // default, so it is free to be filled with something unused — OpenRouter, since
  // slot C's default is no longer groq.
  const lanes = resolveMultiTranscriptionLanes({
    dualTranscriptionProviderA: "groq",
    dualTranscriptionProviderB: "groq",
  });

  assert.deepEqual(providers(lanes), ["groq", "openrouter"]);
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

test("a fresh install runs the three chosen provider/model pairs", async () => {
  const { resolveMultiTranscriptionLanes } = await load();
  // The configuration asked for by ID: xAI Grok STT, OpenAI GPT Transcribe, Groq
  // Whisper Large v3 (not the turbo variant). Slot order is also the merge tie-break.
  assert.deepEqual(
    resolveMultiTranscriptionLanes({}).map((lane) => [lane.provider, lane.model]),
    [
      ["xai", "grok-stt"],
      ["openai", "gpt-transcribe"],
      ["openrouter", "microsoft/mai-transcribe-1.5"],
    ]
  );
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
