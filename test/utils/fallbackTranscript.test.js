const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { chooseFallbackTranscript } = require("../../src/utils/transcriptReconcile.js");

// When the merge is dropped or fails, one lane's raw text is pasted. Slot order picks it,
// because slot order is trust order — and that was enough until a lane started returning
// part of the dictation.
//
// xAI's batch endpoint does: given the same 17-second recording it reports the full
// duration and returns the first 14 words, ending on a dash, every time (checked against
// the live API — six requests, three request shapes, identical output). On a longer
// recording whose speech sits at the end it returns nothing at all: same audio, cut to
// 7.7s it transcribes fine, with 30s of quiet in front of it the response is empty.
//
// So a fragment can be the highest-priority answer, and pasting it while a complete
// transcript sits in the next lane is what these checks are about.

const LANES = {
  // Real dictation, from history row 425: the merge did not run, xAI held slot A, and
  // its fragment is what reached the clipboard.
  xaiFragment: "Also, maybe we should just disable allowing shares to be used, or at least-",
  groqComplete:
    "Also, maybe we should just disable allowing shares to be used, or at least log a " +
    "warning whenever it's used. And the warning should say that these are not split adjusted.",
};

test("a fragment loses to the lane that returned the whole dictation", () => {
  const chosen = chooseFallbackTranscript([
    { provider: "xai", text: LANES.xaiFragment },
    { provider: "groq", text: LANES.groqComplete },
  ]);
  assert.equal(chosen.provider, "groq");
});

test("ordinary disagreement does not override slot order", () => {
  // The widest honest gap measured across 201 real dictations was 17% of the word count —
  // two recognisers hearing the same speech slightly differently. Trusting the longer one
  // there would quietly demote the most accurate recogniser on nearly every dictation.
  const chosen = chooseFallbackTranscript([
    { provider: "xai", text: "one two three four five six seven eight nine ten eleven twelve" },
    {
      provider: "groq",
      text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
    },
  ]);
  assert.equal(chosen.provider, "xai", "a 17% difference is disagreement, not truncation");
});

test("a longer answer needs both a ratio and an absolute margin", () => {
  // Short dictations: five words against three is a 67% difference and means nothing.
  const chosen = chooseFallbackTranscript([
    { provider: "xai", text: "yes that works" },
    { provider: "groq", text: "yes that works for me" },
  ]);
  assert.equal(chosen.provider, "xai");
});

test("a self-declared cut-off loses even by a narrow margin", () => {
  // The trailing dash is the recogniser saying it stopped mid-utterance. Nothing else
  // needs to be true for a complete answer to be the better paste.
  const chosen = chooseFallbackTranscript([
    { provider: "xai", text: "so the plan is we ship the fix and then-" },
    { provider: "openai", text: "So the plan is we ship the fix and then tell everyone." },
  ]);
  assert.equal(chosen.provider, "openai");
});

test("a cut-off leader keeps its place when no other lane did better", () => {
  const chosen = chooseFallbackTranscript([
    { provider: "xai", text: "wait doesn't everything- I'm confused. Why don't we only-" },
    { provider: "openai", text: "Wait, doesn't everything-" },
  ]);
  assert.equal(chosen.provider, "xai", "shorter is not an improvement, marker or not");
});

test("blank and missing answers are ignored rather than chosen", () => {
  assert.equal(chooseFallbackTranscript([]), undefined);
  assert.equal(chooseFallbackTranscript(undefined), undefined);
  const chosen = chooseFallbackTranscript([
    { provider: "xai", text: "   " },
    { provider: "groq", text: "the actual transcript" },
  ]);
  assert.equal(chosen.provider, "groq");
});

test("punctuation and casing do not count as content", () => {
  // The comparison is word counts, so a lane that punctuates cannot win on that alone.
  const chosen = chooseFallbackTranscript([
    { provider: "xai", text: "one two three four five six seven eight" },
    { provider: "groq", text: "One, two, three; four — five, six, seven... eight!" },
  ]);
  assert.equal(chosen.provider, "xai");
});

test("both fallback paths in the fan-out use the chooser", () => {
  // The merge has two ways to produce nothing — every race lane failing outright, or
  // the winning lane answering with nothing usable — and they used to pick the answer
  // independently. A static check because reproducing a live merge race in a unit test
  // would mean mocking two providers, the budget and the store.
  const audioManager = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "helpers", "audioManager.js"),
    "utf8"
  );
  // Bounded from the merge onwards to the next method. Searching for the method name
  // from the top of the file finds an earlier *call* to it and slices nothing, which is
  // how this check first passed vacuously.
  const start = audioManager.indexOf("const reconcileStart = performance.now()");
  const fanOut = audioManager.slice(
    start,
    audioManager.indexOf("\n  getTranscriptionModel() {", start)
  );
  assert.ok(fanOut.length > 500, "could not isolate the fan-out — has it moved?");

  assert.match(fanOut, /chooseFallbackTranscript\(answered\)/, "the chooser is not called");
  const uses = fanOut.match(/text: fallback\.text/g) ?? [];
  assert.equal(uses.length, 2, "expected the all-lanes-failed path and the empty-text path to use it");
  assert.doesNotMatch(
    fanOut,
    /text: answered\[0\]\.text/,
    "a fallback path still pastes slot A's text directly"
  );
});
