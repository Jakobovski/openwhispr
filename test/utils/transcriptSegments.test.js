const test = require("node:test");
const assert = require("node:assert/strict");

const { joinTranscriptSegments } = require("../../src/utils/transcriptSegments.js");

test("empty and malformed input yields an empty string", () => {
  assert.equal(joinTranscriptSegments([]), "");
  assert.equal(joinTranscriptSegments(null), "");
  assert.equal(joinTranscriptSegments(["", "   "]), "");
  assert.equal(joinTranscriptSegments([null, "hello", undefined]), "hello");
});

test("a single segment is returned trimmed", () => {
  assert.equal(joinTranscriptSegments(["  hello world  "]), "hello world");
});

test("the real-world case from the logs reads as one sentence", () => {
  // Four utterance-finals captured while dictating with pauses; xAI capitalized
  // each as a fresh sentence.
  const segments = [
    "We don't need cleanup, just",
    "Just have it, not even try, and then",
    "We don't have to worry about",
    "displaying that error",
  ];
  assert.equal(
    joinTranscriptSegments(segments),
    "We don't need cleanup, just just have it, not even try, and then we don't have to worry about displaying that error"
  );
});

test("a segment following a finished sentence keeps its capital", () => {
  assert.equal(
    joinTranscriptSegments(["Take the screenshot.", "Starts OCR"]),
    "Take the screenshot. Starts OCR"
  );
  assert.equal(joinTranscriptSegments(["Is it done?", "Then ship it"]), "Is it done? Then ship it");
  assert.equal(joinTranscriptSegments(["Stop!", "We are done"]), "Stop! We are done");
});

test("a closing quote or bracket still counts as a finished sentence", () => {
  assert.equal(
    joinTranscriptSegments(['He said "stop."', "Then left"]),
    'He said "stop." Then left'
  );
});

test("the pronoun I is never lowered", () => {
  assert.equal(joinTranscriptSegments(["and then", "I went home"]), "and then I went home");
  assert.equal(joinTranscriptSegments(["and then", "I'm leaving"]), "and then I'm leaving");
});

test("proper nouns and acronyms keep their capitals", () => {
  assert.equal(
    joinTranscriptSegments(["push it to", "GitHub tomorrow"]),
    "push it to GitHub tomorrow"
  );
  assert.equal(joinTranscriptSegments(["query the", "DB directly"]), "query the DB directly");
  assert.equal(joinTranscriptSegments(["ask", "Sinead about it"]), "ask Sinead about it");
  // Internal capitals mark a name, not sentence case.
  assert.equal(joinTranscriptSegments(["open", "MacBook lid"]), "open MacBook lid");
});

test("a lowered word keeps its trailing punctuation", () => {
  assert.equal(joinTranscriptSegments(["I mean", "Then, later"]), "I mean then, later");
});

test("segments already lowercase are untouched", () => {
  assert.equal(joinTranscriptSegments(["one two", "three four"]), "one two three four");
});

test("many segments chain correctly", () => {
  assert.equal(
    joinTranscriptSegments(["Do we even need to", "The result", "And then", "Or don't"]),
    "Do we even need to the result and then or don't"
  );
});
