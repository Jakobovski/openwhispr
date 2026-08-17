const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/config/inferenceModes.ts");

test("a fresh install derives the byok provider mode, not OpenWhispr cloud", async () => {
  const { deriveTranscriptionMode } = await load();
  // The shipped regression: nothing is stored on a first launch, and reading the cloud
  // mode as a bare null derived "openwhispr" — so the app opened on OpenWhispr cloud,
  // which needs a sign-in, while the store's default said byok and multi-transcription
  // sat unreachable behind it.
  assert.equal(deriveTranscriptionMode(false, null, null), "providers");
});

test("an explicit stored mode still decides", async () => {
  const { deriveTranscriptionMode } = await load();
  assert.equal(deriveTranscriptionMode(false, "openwhispr", null), "openwhispr");
  assert.equal(deriveTranscriptionMode(false, "byok", "custom"), "self-hosted");
  assert.equal(deriveTranscriptionMode(false, "byok", "openai"), "providers");
  assert.equal(deriveTranscriptionMode(true, "byok", "openai"), "local");
});

test("the provider migration has nothing to do on a profile with nothing stored", async () => {
  const { hasNoStoredProviderSettings } = await load();
  // A migration that writes anything here is inventing a default that then *beats* the
  // store's, because the store only falls back when a key is absent.
  assert.equal(
    hasNoStoredProviderSettings(() => null),
    true
  );
});

test("the migration still runs for a profile that has stored settings", async () => {
  const { hasNoStoredProviderSettings } = await load();
  const stored = { cloudTranscriptionMode: "byok" };
  assert.equal(
    hasNoStoredProviderSettings((key) => stored[key] ?? null),
    false
  );
});
