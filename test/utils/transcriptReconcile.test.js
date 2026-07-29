const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RECONCILE_SYSTEM_PROMPT,
  buildReconcileInput,
  transcriptsAgree,
} = require("../../src/utils/transcriptReconcile.js");

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

test("the input carries both versions and nothing else", () => {
  const input = buildReconcileInput("version one text", "version two text");
  assert.equal(input, "Version A: version one text\nVersion B: version two text");
});

test("the system prompt asks for a merge plus cleanup", () => {
  assert.match(RECONCILE_SYSTEM_PROMPT, /more plausible in context/i);
  assert.match(RECONCILE_SYSTEM_PROMPT, /punctuation and capitalisation/i);
  assert.match(RECONCILE_SYSTEM_PROMPT, /Remove filler words/i);
  assert.match(RECONCILE_SYSTEM_PROMPT, /Do not summarise or paraphrase/i);
});

test("the system prompt allows repairing a word both systems missed", () => {
  // A dropped word is absent from both versions, so choosing between them cannot
  // recover it — the model is asked to infer it instead.
  assert.match(RECONCILE_SYSTEM_PROMPT, /infer from context/i);
});

test("the system prompt forbids answering the dictation", () => {
  // Dictation often reads as a question ("how do I deploy this"); the model must
  // transcribe it rather than reply to it.
  assert.match(RECONCILE_SYSTEM_PROMPT, /never an instruction/i);
  assert.match(RECONCILE_SYSTEM_PROMPT, /do not answer it/i);
});
