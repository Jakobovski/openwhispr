const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { normalizeDictationTerms } = require("../../src/utils/dictationTerms.js");

// One normaliser for every provider that biases on a term list. It exists because four
// call sites had their own version and they had already diverged — the same dictation
// arrived deduplicated for one provider and not another, and xAI and the whisper-style
// providers were getting the custom dictionary without the terms read off screen.

test("terms are trimmed and blanks dropped", () => {
  assert.deepEqual(normalizeDictationTerms(["  OpenWhispr  ", "", "   ", "Sinead"]), [
    "OpenWhispr",
    "Sinead",
  ]);
});

test("duplicates are removed case-insensitively, keeping the first spelling", () => {
  // The casing is the point: "OpenWhispr" is the whole reason the term is in the list.
  assert.deepEqual(
    normalizeDictationTerms(["OpenWhispr", "openwhispr", "OPENWHISPR", "Sinead"]),
    ["OpenWhispr", "Sinead"]
  );
});

test("non-strings are ignored rather than coerced", () => {
  assert.deepEqual(normalizeDictationTerms([null, 42, undefined, {}, "kept", []]), ["kept"]);
});

test("a non-array is an empty list, not a throw", () => {
  for (const input of [null, undefined, "terms", 42, {}]) {
    assert.deepEqual(normalizeDictationTerms(input), []);
  }
});

test("the limit keeps the head, because the order is deliberate", () => {
  // The curated dictionary comes before terms scraped off the screen, so truncating from
  // the end drops the least-vouched-for words first.
  const terms = Array.from({ length: 50 }, (_, i) => `term${i}`);
  const limited = normalizeDictationTerms(terms, { limit: 3 });
  assert.deepEqual(limited, ["term0", "term1", "term2"]);
});

test("a per-term length cap truncates, and truncation cannot introduce duplicates", () => {
  // xAI caps a term at 50 characters. Two long terms sharing a prefix collapse to the
  // same string once cut — deduplicating before the cut would have let both through.
  const long = "a".repeat(60);
  const alsoLong = "a".repeat(55);
  const out = normalizeDictationTerms([long, alsoLong, "short"], { maxTermLength: 50 });
  assert.deepEqual(out, ["a".repeat(50), "short"]);
});

test("no limit means no cap", () => {
  const terms = Array.from({ length: 1500 }, (_, i) => `t${i}`);
  assert.equal(normalizeDictationTerms(terms).length, 1500);
});

// --- wiring: one generator, one shaper ---

const audioManager = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "helpers", "audioManager.js"),
  "utf8"
);

test("every provider's terms come from the one shaper", () => {
  // The failure this prevents: a new provider assembling its own list, which is how xAI
  // and the whisper-style prompt ended up without the on-screen terms.
  for (const provider of ["xai", "azure-speech", "gemini", "soniox"]) {
    assert.match(
      audioManager,
      new RegExp(`getProviderTerms\\("${provider}"\\)`),
      `${provider} must get its terms from getProviderTerms`
    );
  }
  // And the whisper-style providers go through the prompt form of the same builder.
  assert.match(audioManager, /await this\.getDictationPrompt\(provider\)/);
});

test("the old per-provider term helpers are gone", () => {
  // Leaving them behind is how a future call site quietly picks the dictionary-only one.
  assert.doesNotMatch(audioManager, /getXaiKeyterms/, "getXaiKeyterms should be removed");
  assert.doesNotMatch(
    audioManager,
    /\bgetKeyterms\s*\(/,
    "getKeyterms (dictionary only) should be removed"
  );
});

test("provider ceilings live in one table, not at the call sites", () => {
  assert.match(audioManager, /const PROVIDER_TERM_SHAPES = \{/);
  // The magic numbers that used to be inline.
  assert.doesNotMatch(
    audioManager,
    /provider === "groq" \? 890 : 900/,
    "the groq prompt cap should come from the shape table"
  );
  assert.doesNotMatch(
    audioManager,
    /\.slice\(0, 50\)\s*\)\s*\n\s*\.filter\(Boolean\)/,
    "the hand-rolled xai term mapping should be gone"
  );
});

test("the echo guard compares against the prompt that was actually sent", () => {
  // The prompt now carries on-screen terms, so rebuilding a dictionary-only string for
  // the comparison would either miss an echo or reject real speech as one.
  assert.match(
    audioManager,
    /this\._lastDictationPrompt \?\? this\.getCustomDictionaryPrompt\(\)/,
    "isDictionaryEcho must prefer the remembered prompt"
  );
  assert.match(audioManager, /this\._lastDictationPrompt = prompt;/, "the prompt must be recorded");
  assert.match(
    audioManager,
    /this\._lastDictationPrompt = null;/,
    "and cleared when no prompt is sent, or a stale one would be compared against"
  );
});
