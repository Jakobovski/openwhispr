const test = require("node:test");
const assert = require("node:assert/strict");

// Node strips the types (24 in CI, 23.6+ locally), so the .ts source loads directly.
const load = () => import("../../src/utils/transcriptDiff.ts");

const changed = (tokens) =>
  tokens
    .filter((token) => token.changed)
    .map((token) => token.text.trim())
    .join(" ");

test("identical transcripts have nothing marked", async () => {
  const { diffTranscripts } = await load();
  const text = "pull the revenue numbers by product line";
  const diff = diffTranscripts(text, text);

  assert.equal(changed(diff.a), "");
  assert.equal(changed(diff.b), "");
  assert.equal(diff.changeRatio, 0);
});

test("a misheard name is marked on both sides", async () => {
  const { diffTranscripts } = await load();
  // The real case: one provider heard "Priya", the other "Pria".
  const diff = diffTranscripts("let's get Priya to check it", "let's get Pria to check it");

  assert.equal(changed(diff.a), "Priya");
  assert.equal(changed(diff.b), "Pria");
});

test("punctuation and case alone are the quiet tier, not the loud one", async () => {
  const { diffTranscripts } = await load();
  const diff = diffTranscripts("Right, so the plan.", "right so the plan");

  // Not a word disagreement...
  assert.equal(changed(diff.a), "");
  assert.equal(diff.changeRatio, 0);
  // ...but still flagged, or two visibly different transcripts would render with
  // nothing marked at all and the diff would look broken. This is the real case from
  // history: two providers that agreed on every word but not on the commas.
  assert.equal(diff.punctuationOnly, true);
  assert.deepEqual(
    diff.a.filter((token) => token.punctuationOnly).map((token) => token.text.trim()),
    ["Right,", "plan."]
  );
});

test("identical text is neither tier", async () => {
  const { diffTranscripts } = await load();
  const diff = diffTranscripts("same words here", "same words here");

  assert.equal(diff.punctuationOnly, false);
  assert.ok(!diff.a.some((token) => token.punctuationOnly));
});

test("a word disagreement outranks the punctuation tier", async () => {
  const { diffTranscripts } = await load();
  const diff = diffTranscripts("get Priya, now", "get Pria now");

  assert.equal(changed(diff.a), "Priya,");
  assert.equal(diff.punctuationOnly, false, "punctuationOnly is only for the no-word-diff case");
});

test("a word only one side heard is marked on that side alone", async () => {
  const { diffTranscripts } = await load();
  const diff = diffTranscripts("flag anything that drifted", "flag anything that really drifted");

  assert.equal(changed(diff.a), "");
  assert.equal(changed(diff.b), "really");
});

test("differing numeral styles are a real disagreement", async () => {
  const { diffTranscripts } = await load();
  const diff = diffTranscripts("more than 5%", "more than five percent");

  assert.equal(changed(diff.a), "5%");
  assert.equal(changed(diff.b), "five percent");
});

test("joining the tokens restores each side exactly", async () => {
  const { diffTranscripts } = await load();
  // The rendered output is these tokens in order, so any lost whitespace or dropped
  // word would show up as a corrupted transcript in the history view.
  const a = "first line here\nsecond  line  spaced";
  const b = "first line there\nsecond line spaced";
  const diff = diffTranscripts(a, b);

  assert.equal(
    diff.a.map((token) => token.text).join(""),
    a,
    "side A must round-trip through the diff"
  );
  assert.equal(
    diff.b.map((token) => token.text).join(""),
    b,
    "side B must round-trip through the diff"
  );
});

test("the change ratio reports how much the two disagree", async () => {
  const { diffTranscripts } = await load();
  const diff = diffTranscripts("one two three four", "one two three five");

  assert.equal(diff.changeRatio, 0.25);
});

test("empty input is handled without dividing by zero", async () => {
  const { diffTranscripts } = await load();

  assert.deepEqual(diffTranscripts("", ""), {
    a: [],
    b: [],
    changeRatio: 0,
    punctuationOnly: false,
  });
  const diff = diffTranscripts("", "something");
  assert.equal(diff.changeRatio, 1);
  assert.equal(changed(diff.b), "something");
});
