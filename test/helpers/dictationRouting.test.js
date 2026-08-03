const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictationRouting.js");

test("voice agent hotkey routes to the agent without a wake word", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: false,
      voiceAgentRequested: true,
    }),
    "agent"
  );
});

test("voice agent hotkey never triggers cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  // Even with cleanup enabled and reachable, a voice agent recording with an
  // unreachable agent returns the raw transcript instead of falling back.
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: true,
    }),
    "skip"
  );
});

test("voice agent hotkey ignores the wake word state", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: true,
    }),
    "agent"
  );
});

test("normal dictation with wake word routes to the agent", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: false,
    }),
    "agent"
  );
});

test("normal dictation without wake word routes to cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: false,
      voiceAgentRequested: false,
    }),
    "cleanup"
  );
});

test("wake word with unreachable agent falls back to cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: true,
      voiceAgentRequested: false,
    }),
    "cleanup"
  );
});

test("skips reasoning when nothing is reachable", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: false,
    }),
    "skip"
  );
});

test("agent is reachable in cloud mode without an explicit model", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: true,
      dictationAgentModel: "",
      isCloudAgent: true,
      isSelfHostedAgent: false,
    }),
    true
  );
});

test("agent is reachable in self-hosted mode without an explicit model", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: true,
      dictationAgentModel: "",
      isCloudAgent: false,
      isSelfHostedAgent: true,
    }),
    true
  );
});

test("agent is unreachable with an empty model on a model-required provider", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: true,
      dictationAgentModel: "   ",
      isCloudAgent: false,
      isSelfHostedAgent: false,
    }),
    false
  );
});

test("agent is reachable with an explicit model (BYOK/local/enterprise)", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: true,
      dictationAgentModel: "gpt-5.5",
      isCloudAgent: false,
      isSelfHostedAgent: false,
    }),
    true
  );
});

test("disabling the dictation agent overrides cloud reachability", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: false,
      dictationAgentModel: "",
      isCloudAgent: true,
      isSelfHostedAgent: true,
    }),
    false
  );
});

test("translation hotkey routes to translation when reachable", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: false,
      voiceAgentRequested: false,
      translationRequested: true,
      translationReachable: true,
    }),
    "translation"
  );
});

test("translation hotkey ignores the wake word state", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: false,
      translationRequested: true,
      translationReachable: true,
    }),
    "translation"
  );
});

test("unreachable translation degrades to cleanup, not to the agent", async () => {
  const { resolveDictationRouteKind } = await load();

  // Deliberately different from the voice agent's hard skip: a dictation meant
  // for translation is still a useful dictation, so keep the cleanup.
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: false,
      translationRequested: true,
      translationReachable: false,
    }),
    "cleanup"
  );
});

test("unreachable translation with unreachable cleanup skips reasoning", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: true,
      agentInvoked: false,
      voiceAgentRequested: false,
      translationRequested: true,
      translationReachable: false,
    }),
    "skip"
  );
});

test("normal dictation never takes the translation route", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: false,
      translationRequested: false,
      translationReachable: true,
    }),
    "cleanup"
  );
});

test("translation is unreachable when disabled", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: false,
      translationTargetLanguage: "it",
      translationModel: "gpt-5-mini",
      isCloudTranslation: true,
      isSelfHostedTranslation: false,
    }),
    false
  );
});

test("translation is unreachable without a target language", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "   ",
      translationModel: "gpt-5-mini",
      isCloudTranslation: true,
      isSelfHostedTranslation: false,
    }),
    false
  );
});

test("translation is reachable in cloud mode without an explicit model", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "it",
      translationModel: "",
      isCloudTranslation: true,
      isSelfHostedTranslation: false,
    }),
    true
  );
});

test("translation is reachable in self-hosted mode without an explicit model", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "it",
      translationModel: "",
      isCloudTranslation: false,
      isSelfHostedTranslation: true,
    }),
    true
  );
});

test("translation needs a model on model-required providers", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "it",
      translationModel: "  ",
      isCloudTranslation: false,
      isSelfHostedTranslation: false,
    }),
    false
  );

  const { resolveDictationTranslationReachability: reach } = await load();
  assert.equal(
    reach({
      useDictationTranslation: true,
      translationTargetLanguage: "it",
      translationModel: "qwen3:8b",
      isCloudTranslation: false,
      isSelfHostedTranslation: false,
    }),
    true
  );
});

test("a reconciled transcript skips the cleanup pass", async () => {
  const { resolveDictationRouteKind } = await load();

  // Dual transcription's reconcile prompt cleans while it merges, so a second
  // cleanup call would re-clean clean text — and on Groq's per-model TPM budget
  // the pair does not fit, which 429s and pastes the raw transcript instead.
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: false,
      alreadyCleaned: true,
    }),
    "skip"
  );
});

test("an unreconciled dual transcript is still cleaned", async () => {
  const { resolveDictationRouteKind } = await load();

  // Providers agreeing, or one side dropped/failed, leaves the text raw.
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: false,
      alreadyCleaned: false,
    }),
    "cleanup"
  );
  // Omitting the flag entirely must behave like the single-provider path.
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: false,
    }),
    "cleanup"
  );
});

test("already-cleaned text still reaches the agent and translation paths", async () => {
  const { resolveDictationRouteKind } = await load();

  // The reconcile prompt cleans; it does not answer an agent command or translate.
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: false,
      alreadyCleaned: true,
    }),
    "agent"
  );
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: false,
      translationRequested: true,
      translationReachable: true,
      alreadyCleaned: true,
    }),
    "translation"
  );
});

test("an unreachable translation on cleaned text skips instead of re-cleaning", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: false,
      translationRequested: true,
      translationReachable: false,
      alreadyCleaned: true,
    }),
    "skip"
  );
});
