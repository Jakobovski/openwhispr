const test = require("node:test");
const assert = require("node:assert/strict");

const { extractCorrections } = require("../../src/utils/correctionLearner.js");

test("null or empty inputs yield no corrections", () => {
  assert.deepEqual(extractCorrections(null, "hello", []), []);
  assert.deepEqual(extractCorrections("hello", null, []), []);
  assert.deepEqual(extractCorrections("", "hello", []), []);
  assert.deepEqual(extractCorrections("hello", "", []), []);
});

test("identical texts yield no corrections", () => {
  assert.deepEqual(extractCorrections("hello world", "hello world", []), []);
});

test("a phonetic mishearing fixed by the user is learned", () => {
  // "Shunade" is a plausible transcription mishearing of "Sinead"
  const result = extractCorrections("Hey Shunade how are you", "Hey Sinead how are you", []);
  assert.ok(result.includes("Sinead"));
});

test("corrections already in the dictionary are not re-learned, case-insensitively", () => {
  const original = "Hey Shunade how are you";
  const edited = "Hey Sinead how are you";

  assert.ok(!extractCorrections(original, edited, ["Sinead"]).includes("Sinead"));
  assert.ok(!extractCorrections(original, edited, ["sinead"]).includes("Sinead"));
});

test("a wholesale rewrite is not mistaken for corrections", () => {
  const result = extractCorrections("the cat sat on the mat", "a dog stood under a rug", []);
  assert.deepEqual(result, []);
});

test("very short replacements are ignored — two-letter words are edits, not vocabulary", () => {
  const result = extractCorrections("I went to see XX today", "I went to see Al today", []);
  assert.ok(!result.includes("Al"));
});

test("unrelated word swaps are filtered by edit distance — cat to elephant is a rewrite, not a mishearing", () => {
  const result = extractCorrections("I saw a cat yesterday", "I saw a elephant yesterday", []);
  assert.ok(!result.includes("elephant"));
});

test("a non-array dictionary is tolerated", () => {
  const result = extractCorrections("Hey Shunade", "Hey Sinead", null);
  assert.ok(result.includes("Sinead"));
});

test("the same correction appearing twice is only learned once", () => {
  const result = extractCorrections("Shunade said hi to Shunade", "Sinead said hi to Sinead", []);
  const sinead = result.filter((w) => w.toLowerCase() === "sinead");
  assert.ok(sinead.length <= 1);
});

test("a cleared field is not treated as an edit", () => {
  // Submitting the message empties the field; nothing was corrected.
  assert.deepEqual(extractCorrections("Ask Sinead about the deploy", "", []), []);
  assert.deepEqual(extractCorrections("Ask Sinead about the deploy", "\n", []), []);
  assert.deepEqual(extractCorrections("Ask Sinead about the deploy", "   ", []), []);
});

test("placeholder text read back from an empty field is not treated as an edit", () => {
  // The real false positive: after submitting, the accessibility read returns the
  // field's placeholder, which shares nothing with the dictation.
  const original = "Is that happening in addition to the reconciliation";
  for (const placeholder of [
    "Type / for commands",
    "Message OpenWhispr",
    "Send a message...",
    "Search or type a command",
  ]) {
    assert.deepEqual(extractCorrections(original, placeholder, []), [], placeholder);
  }
});

test("an unrelated field's contents are not treated as an edit", () => {
  // Focus moved elsewhere between paste and read.
  assert.deepEqual(
    extractCorrections("Ask Sinead about the deploy", "git commit --amend --no-edit", []),
    []
  );
});

test("a genuine correction still survives the retention guard", () => {
  // Most of the dictation is still there, so this is a real edit.
  const result = extractCorrections(
    "Ask Shunade about the deploy tomorrow",
    "Ask Sinead about the deploy tomorrow",
    []
  );
  assert.ok(result.includes("Sinead"), `expected Sinead, got ${JSON.stringify(result)}`);
});

// --- what is worth learning at all ---
//
// Every term in the dictionary is sent to every provider on every dictation as a
// recognition hint, so a word of ordinary English is not free to add: it is noise in the
// bias list forever. These are the actual entries auto-learn put in a real dictionary
// before this filter existed.

test("a contraction the user typed is not vocabulary", () => {
  // The lexicon holds "there" and not "there's", so every contraction came back unknown
  // and was learned. Real entries: there's, it's, I'm, that's, don't, didn't, doesn't,
  // shouldn't, repository's.
  const learned = extractCorrections(
    "I think theres a problem here today",
    "I think there's a problem here today",
    []
  );
  assert.deepEqual(learned, [], `learned a contraction: ${JSON.stringify(learned)}`);
});

test("a possessive of an ordinary word is not vocabulary", () => {
  const learned = extractCorrections(
    "Check the repositorys history for that change",
    "Check the repository's history for that change",
    []
  );
  assert.deepEqual(learned, []);
});

test("correcting one real word to another is a wording fix, not a term", () => {
  const learned = extractCorrections(
    "We used web scrapping for this data",
    "We used web scraping for this data",
    []
  );
  assert.deepEqual(learned, [], `learned a common word: ${JSON.stringify(learned)}`);
});

test("two words glued across a missing space are never learned", () => {
  // "those.Not" was a real entry: the tokenizer splits on whitespace, so a missing space
  // after a full stop leaves both words in one token.
  const learned = extractCorrections(
    "I checked those.Not all of them are ready",
    "I checked those.Note all of them are ready",
    []
  );
  assert.ok(
    !learned.some((w) => /[.,;:!?]/.test(w)),
    `learned a glued token: ${JSON.stringify(learned)}`
  );
});

test("a bare number is not vocabulary", () => {
  // "100" was a real entry.
  const learned = extractCorrections(
    "We need 1000 of them by friday",
    "We need 100 of them by friday",
    []
  );
  assert.deepEqual(learned, []);
});

test("a name the recogniser mangled is still learned, or the feature does nothing", () => {
  // The case the filter must not break: neither spelling is a word of the language, and
  // this is exactly what the dictionary is for.
  assert.deepEqual(
    extractCorrections("Call Shunade about the meeting today", "Call Sinead about the meeting today", []),
    ["Sinead"]
  );
});

test("a contraction whose base is too short for the lexicon is still rejected", () => {
  // The bug in the first version of this filter. It stripped the tail and asked the
  // lexicon about the base, but the lexicon holds nothing under four letters — so "do",
  // "it", "did" and "the" all read as unknown words and don't, it's, I'm and didn't were
  // learned anyway. Every one of those was a real entry.
  const cases = [
    ["I dont think so at all today", "I don't think so at all today"],
    ["I think its ready for review now", "I think it's ready for review now"],
    ["I didnt see the message you sent", "I didn't see the message you sent"],
  ];
  for (const [before, after] of cases) {
    const learned = extractCorrections(before, after, []);
    assert.deepEqual(learned, [], `learned ${JSON.stringify(learned)} from ${JSON.stringify(after)}`);
  }
});

