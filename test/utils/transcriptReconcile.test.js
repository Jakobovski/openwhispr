const test = require("node:test");
const assert = require("node:assert/strict");

const { transcriptsAgree } = require("../../src/utils/transcriptReconcile.js");

// When both systems already say the same thing there is nothing to merge, so
// the LLM call is skipped — the common case for clean audio.

test("identical transcriptions agree", () => {
  assert.equal(transcriptsAgree("ship the release today", "ship the release today"), true);
});

test("agreement ignores case and punctuation", () => {
  assert.equal(transcriptsAgree("Ship the release today.", "ship the release today"), true);
  assert.equal(transcriptsAgree("Well, yes -- ship it!", "well yes ship it"), true);
});

test("a real difference does not agree", () => {
  assert.equal(transcriptsAgree("ask Sinead about it", "ask Shunade about it"), false);
});

test("empty input never agrees, so it is never mistaken for a settled merge", () => {
  assert.equal(transcriptsAgree("", ""), false);
  assert.equal(transcriptsAgree("", "something"), false);
  assert.equal(transcriptsAgree(null, null), false);
});
