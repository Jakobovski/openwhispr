const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/services/ai/thinkingSuppressionDialects.ts");

test("groq qwen models get reasoning_effort none and never chat_template_kwargs", async () => {
  const { suppressThinking } = await load();

  const body = {};
  suppressThinking(body, "groq", "qwen/qwen3-32b");

  assert.deepEqual(body, { reasoning_effort: "none" });
  assert.ok(!("chat_template_kwargs" in body), "Groq rejects chat_template_kwargs with a 400");
});

test("groq gpt-oss models get reasoning_effort low, the lowest value that family accepts", async () => {
  const { suppressThinking } = await load();

  const body = {};
  suppressThinking(body, "groq", "openai/gpt-oss-120b");

  assert.deepEqual(body, { reasoning_effort: "low" });
  assert.ok(!("chat_template_kwargs" in body), "Groq rejects chat_template_kwargs with a 400");
});

test("groq model family matching is case insensitive", async () => {
  const { suppressThinking } = await load();

  const qwen = {};
  suppressThinking(qwen, "groq", "Qwen/Qwen3-32B");
  assert.equal(qwen.reasoning_effort, "none");

  const gptOss = {};
  suppressThinking(gptOss, "groq", "OpenAI/GPT-OSS-20B");
  assert.equal(gptOss.reasoning_effort, "low");
});

test("groq models of an unknown family are left untouched rather than sent a guessed enum", async () => {
  const { suppressThinking } = await load();

  const body = { model: "llama-3.3-70b-versatile", messages: [] };
  suppressThinking(body, "groq", "llama-3.3-70b-versatile");

  assert.deepEqual(body, { model: "llama-3.3-70b-versatile", messages: [] });
});

test("groq tolerates a missing model without throwing", async () => {
  const { suppressThinking } = await load();

  const body = {};
  suppressThinking(body, "groq", undefined);

  assert.deepEqual(body, {});
});

test("gemini gets reasoning_effort minimal and nothing else", async () => {
  const { suppressThinking } = await load();

  const body = {};
  suppressThinking(body, "gemini", "gemini-3-flash-preview");

  assert.deepEqual(body, { reasoning_effort: "minimal" });
});

test("openrouter gets a hard disable, not the softer effort request", async () => {
  // `effort: "minimal"` shipped briefly and was itself wrong the other direction:
  // it's a request a model is free to ignore, and at least one (nvidia's
  // nemotron-3.5-lightning) does — spending 1300+ reasoning tokens regardless and
  // blowing the completion budget before any content came out. `{ enabled: false }`
  // genuinely zeroes reasoning on models that accept it. The models that reject it
  // outright are handled by a live retry in openai.ts, not by weakening the request
  // everyone else gets.
  const { suppressThinking } = await load();

  const body = {};
  suppressThinking(body, "openrouter", "qwen/qwen3-32b");

  assert.deepEqual(body, { reasoning: { enabled: false } });
});

test("a reasoningMandatory model gets the softer request up front, not after a rejection", async () => {
  // Models that refuse a hard disable ("Reasoning is mandatory for this endpoint and
  // cannot be disabled" — live for openai/gpt-oss-120b, Gemini 3.6/3.7 Flash, Muse
  // Glimmer) are declared in the registry, so the first call already sends what they
  // accept. Without this every call to such a model burns a whole round trip being
  // rejected: 67ms of a 189ms merge for gpt-oss-120b, and that merge is in the paste
  // path.
  const { suppressThinking } = await load();

  const body = {};
  suppressThinking(body, "openrouter", "openai/gpt-oss-120b", true);

  assert.deepEqual(body, { reasoning: { effort: "minimal" } });
});

test("an unflagged or unknown model keeps the hard disable", async () => {
  // The flag must never be assumed. nemotron-3.5-lightning accepts { enabled: false }
  // and *ignores* effort:minimal, so downgrading a model that didn't ask for it is the
  // regression this asserts against — both for an explicit false and for a model the
  // registry has no opinion about (undefined).
  const { suppressThinking } = await load();

  for (const flag of [undefined, false]) {
    const body = {};
    suppressThinking(body, "openrouter", "nvidia/nemotron-3.5-lightning", flag);
    assert.deepEqual(
      body,
      { reasoning: { enabled: false } },
      `flag ${String(flag)} must not weaken the request`
    );
  }
});

test("local gets think false plus chat_template_kwargs", async () => {
  const { suppressThinking } = await load();

  const body = {};
  suppressThinking(body, "local", "qwen3-8b");

  assert.deepEqual(body, { think: false, chat_template_kwargs: { enable_thinking: false } });
});

test("lan gets the nested reasoning object plus chat_template_kwargs", async () => {
  const { suppressThinking } = await load();

  const body = {};
  suppressThinking(body, "lan", "qwen3-8b");

  assert.deepEqual(body, {
    reasoning: { effort: "none" },
    chat_template_kwargs: { enable_thinking: false },
  });
});

test("unlisted providers keep the legacy reasoning_effort none plus chat_template_kwargs", async () => {
  const { suppressThinking } = await load();

  const body = {};
  suppressThinking(body, "openai", "gpt-5.2");

  assert.deepEqual(body, {
    reasoning_effort: "none",
    chat_template_kwargs: { enable_thinking: false },
  });
});

test("mistral gets reasoning_effort none and never chat_template_kwargs", async () => {
  const { suppressThinking } = await load();

  const body = {};
  suppressThinking(body, "mistral", "mistral-small-latest");

  assert.deepEqual(body, { reasoning_effort: "none" });
  assert.ok(!("chat_template_kwargs" in body), "Mistral rejects chat_template_kwargs with a 422");
});

test("mistral magistral models are left untouched because they reason natively", async () => {
  const { suppressThinking } = await load();

  const body = { model: "magistral-medium-latest", messages: [] };
  suppressThinking(body, "mistral", "Magistral-Medium-Latest");

  assert.deepEqual(body, { model: "magistral-medium-latest", messages: [] });
});

test("mistral tolerates a missing model without throwing", async () => {
  const { suppressThinking } = await load();

  const body = {};
  suppressThinking(body, "mistral", undefined);

  assert.deepEqual(body, { reasoning_effort: "none" });
});

test("detectEndpointDialect maps the mistral api base to max_tokens and temperature", async () => {
  const { detectEndpointDialect } = await load();

  assert.deepEqual(detectEndpointDialect("https://api.mistral.ai/v1"), {
    key: "mistral",
    tokenParam: "max_tokens",
    supportsTemperature: true,
  });
});

test("detectEndpointDialect matches mistral hosts regardless of scheme, case, port or path", async () => {
  const { detectEndpointDialect } = await load();

  assert.equal(detectEndpointDialect("api.mistral.ai/v1")?.key, "mistral");
  assert.equal(detectEndpointDialect("https://mistral.ai")?.key, "mistral");
  assert.equal(detectEndpointDialect("https://API.Mistral.AI/v1/")?.key, "mistral");
  assert.equal(detectEndpointDialect("https://api.mistral.ai:443/v1")?.key, "mistral");
  assert.equal(detectEndpointDialect("https://user@api.mistral.ai/v1")?.key, "mistral");
  assert.equal(detectEndpointDialect("https://api.mistral.ai/v1/chat/completions")?.key, "mistral");
});

test("detectEndpointDialect rejects lookalike hosts", async () => {
  const { detectEndpointDialect } = await load();

  assert.equal(detectEndpointDialect("https://api.openai.com/v1"), null);
  assert.equal(detectEndpointDialect("https://notmistral.ai"), null);
  assert.equal(detectEndpointDialect("https://mistral.ai.evil.com"), null);
});

test("detectEndpointDialect returns null for unparseable or missing input", async () => {
  const { detectEndpointDialect } = await load();

  assert.equal(detectEndpointDialect("::::"), null);
  assert.equal(detectEndpointDialect(""), null);
  assert.equal(detectEndpointDialect(undefined), null);
  assert.equal(detectEndpointDialect(null), null);
});

test("xai gets reasoning_effort low, the lowest value its enum accepts", async () => {
  const { suppressThinking } = await load();

  const body = {};
  suppressThinking(body, "xai", "grok-4.5");

  // xAI's enum is low|medium|high with no "none", and chat_template_kwargs is not
  // one of its parameters — the generic branch would send both and be rejected.
  assert.deepEqual(body, { reasoning_effort: "low" });
  assert.ok(!("chat_template_kwargs" in body), "xAI does not accept chat_template_kwargs");
});
