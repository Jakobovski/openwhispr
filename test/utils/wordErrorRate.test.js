const test = require("node:test");
const assert = require("node:assert/strict");

const { wordErrorRate, normalizeWords } = require("../../src/utils/wordErrorRate.js");

const wer = (hyp, ref) => wordErrorRate(hyp, ref);

test("an identical transcript scores zero", () => {
  assert.equal(wer("deploy openwhispr to kubernetes", "deploy openwhispr to kubernetes"), 0);
});

test("each substitution, insertion and deletion counts once", () => {
  // One word swapped out of four.
  assert.equal(wer("deploy openwhispr to grafana", "deploy openwhispr to kubernetes"), 0.25);
  // One word missing.
  assert.equal(wer("deploy openwhispr kubernetes", "deploy openwhispr to kubernetes"), 0.25);
  // One word added.
  assert.equal(wer("deploy the openwhispr to kubernetes", "deploy openwhispr to kubernetes"), 0.25);
});

test("cleanup is not counted as error", () => {
  // The merge punctuates, capitalises and rewrites numbers. Scoring those as mistakes
  // would measure how much tidying a transcript needed, not how much was misheard.
  assert.equal(wer("deploy openwhispr to kubernetes", "Deploy OpenWhispr to Kubernetes."), 0);
  assert.equal(wer("send it by friday", "Send it by Friday!"), 0);
  assert.equal(wer("its ready dont wait", "It's ready — don't wait."), 2 / 4);
});

test("a real mishearing is counted, including one word heard as several", () => {
  // The case the phrase list fixes: three tokens where one word was said. Two
  // insertions and a substitution against a four-word reference.
  const rate = wer("deploy a pen whisper to kubernetes", "deploy openwhispr to kubernetes");
  assert.ok(rate > 0.4 && rate <= 0.75, `expected a large but finite rate, got ${rate}`);
});

test("an empty reference scores null rather than zero", () => {
  // No denominator. Zero would claim a perfect score for a comparison that never
  // happened, and would drag every average toward zero.
  assert.equal(wer("anything at all", ""), null);
  assert.equal(wer("anything at all", "   "), null);
  assert.equal(wer("anything", null), null);
});

test("an empty hypothesis scores every reference word as an error", () => {
  // A lane that returned nothing is not a lane that agreed.
  assert.equal(wer("", "deploy openwhispr to kubernetes"), 1);
});

test("the rate is not clamped at one", () => {
  // A transcript can carry more errors than the reference has words. Clamping would
  // flatten exactly the outliers worth noticing.
  const rate = wer("one two three four five six seven eight", "hello");
  assert.ok(rate > 1, `expected above 1, got ${rate}`);
});

test("normalisation keeps words and intra-word apostrophes only", () => {
  assert.deepEqual(normalizeWords("Don't — stop, now!"), ["don't", "stop", "now"]);
  assert.deepEqual(normalizeWords("  "), []);
  assert.deepEqual(normalizeWords(null), []);
  // Quoted words should not keep their quotes, or they would never match the same word
  // unquoted in the other transcript.
  assert.deepEqual(normalizeWords("'quoted' word"), ["quoted", "word"]);
});
