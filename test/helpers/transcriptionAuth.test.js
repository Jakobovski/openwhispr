const test = require("node:test");
const assert = require("node:assert/strict");

test("returns true for self-hosted mode with configured URL", async () => {
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(
    shouldSkipTranscriptionApiKey({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
    }),
    true
  );
});

test("returns false for self-hosted mode without URL", async () => {
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(
    shouldSkipTranscriptionApiKey({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "",
    }),
    false
  );
});

test("returns false for self-hosted mode with whitespace-only URL", async () => {
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(
    shouldSkipTranscriptionApiKey({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "   ",
    }),
    false
  );
});

test("returns false for openai cloud provider mode", async () => {
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(
    shouldSkipTranscriptionApiKey({
      transcriptionMode: "",
      cloudTranscriptionProvider: "openai",
      remoteTranscriptionUrl: "",
    }),
    false
  );
});

test("provider-specific transcription does not run the unrelated OpenAI key preflight", async () => {
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  for (const cloudTranscriptionProvider of ["gemini", "soniox", "meta"]) {
    assert.equal(
      shouldSkipTranscriptionApiKey({ cloudTranscriptionProvider }),
      true,
      cloudTranscriptionProvider
    );
  }
});

test("returns false when transcriptionMode is missing from settings", async () => {
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(shouldSkipTranscriptionApiKey({}), false);
});

test("returns false for non-self-hosted mode even with URL configured", async () => {
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(
    shouldSkipTranscriptionApiKey({
      transcriptionMode: "cloud",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
    }),
    false
  );
});
