const test = require("node:test");
const assert = require("node:assert/strict");

const { isCleanupPermanentlyUnavailable } = require("../../src/utils/cleanupFailure.js");

test("a standing configuration gap is not surfaced to the user", () => {
  // These recur identically on every recording and the user cannot act on them
  // from the dictation panel.
  for (const message of [
    "OpenWhispr API URL not configured",
    "Not authenticated",
    "No API key configured. Add your key in Settings.",
    "User is not signed in",
  ]) {
    assert.equal(isCleanupPermanentlyUnavailable(new Error(message)), true, message);
  }
});

test("a transient failure is still surfaced", () => {
  // Cleanup normally works for this user; they should know it didn't this time.
  for (const message of [
    "fetch failed",
    "429 Too Many Requests",
    "socket hang up",
    "Cloud reasoning returned an empty response",
    "500 Internal Server Error",
  ]) {
    assert.equal(isCleanupPermanentlyUnavailable(new Error(message)), false, message);
  }
});

test("a missing or malformed error is treated as transient", () => {
  // Better a spurious toast than silently swallowing an unrecognised failure.
  assert.equal(isCleanupPermanentlyUnavailable(null), false);
  assert.equal(isCleanupPermanentlyUnavailable(undefined), false);
  assert.equal(isCleanupPermanentlyUnavailable({}), false);
  assert.equal(isCleanupPermanentlyUnavailable(new Error("")), false);
});

test("matching is case-insensitive", () => {
  assert.equal(isCleanupPermanentlyUnavailable(new Error("API URL NOT CONFIGURED")), true);
  assert.equal(isCleanupPermanentlyUnavailable(new Error("not AUTHENTICATED")), true);
});
