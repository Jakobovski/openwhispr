const test = require("node:test");
const assert = require("node:assert/strict");

// Node strips the types, so the TS config module loads directly.
const load = () => import("../../src/config/dualTranscription.ts");

const providers = (lanes) => lanes.map((lane) => lane.provider);

test("empty settings run the three slot defaults, in order", async () => {
  const { resolveMultiTranscriptionLanes } = await load();
  assert.deepEqual(providers(resolveMultiTranscriptionLanes({})), ["xai", "openai", "groq"]);
});

test("a stored slot combined with a colliding default does not duplicate a provider", async () => {
  const { resolveMultiTranscriptionLanes } = await load();
  // The real failure: slot A was stored as openai from the settings UI, slot B had no
  // stored value and its default had just been changed to openai. Every dictation went to
  // OpenAI twice and xAI never ran — visible only as "openai:ok, openai:ok, groq:ok" in a
  // log line.
  const lanes = resolveMultiTranscriptionLanes({ dualTranscriptionProviderA: "openai" });

  assert.deepEqual(providers(lanes), ["openai", "xai", "groq"]);
  assert.equal(new Set(providers(lanes)).size, 3, "no provider runs twice");
});

test("an explicitly chosen duplicate runs once rather than overriding the choice", async () => {
  const { resolveMultiTranscriptionLanes } = await load();
  // Both A and B stored as groq by hand: honour the choice and drop the redundant call,
  // rather than substituting a provider the user did not ask for. Slot C is still on its
  // default, so it is free to be filled with something unused.
  const lanes = resolveMultiTranscriptionLanes({
    dualTranscriptionProviderA: "groq",
    dualTranscriptionProviderB: "groq",
  });

  assert.deepEqual(providers(lanes), ["groq", "xai"]);
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

test("each lane carries the model for the provider that ended up in it", async () => {
  const { resolveMultiTranscriptionLanes } = await load();
  // The substituted slot must not inherit the model stored for the provider it replaced,
  // or a Groq model id would be sent to xAI's endpoint.
  const lanes = resolveMultiTranscriptionLanes({
    dualTranscriptionProviderA: "openai",
    dualTranscriptionModelB: "whisper-large-v3-turbo",
  });

  const substituted = lanes.find((lane) => lane.provider === "xai");
  assert.equal(substituted.model, "whisper-large-v3-turbo");
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
