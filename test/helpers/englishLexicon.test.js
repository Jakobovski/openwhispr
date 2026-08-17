const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const lexicon = require("../../src/helpers/englishLexicon");

// The dictionary is a system file, so these adapt: on a machine that has one the
// filtering is asserted, and on one that does not (a Linux CI box, a stripped image)
// the documented fallback is asserted instead. Skipping outright would let a
// regression in the fallback path ship unnoticed.
const HAS_DICTIONARY = lexicon.DICTIONARY_PATHS.some((p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
});

test("availability is reported honestly", () => {
  const { available } = lexicon.dropDictionaryWords(["Kubernetes"]);
  assert.equal(available, HAS_DICTIONARY);
});

test("ordinary English is dropped and distinctive terms are kept", () => {
  const input = ["Three", "Error", "move", "reticent", "Kubernetes", "Sinead", "api_key"];
  const { terms, dropped } = lexicon.dropDictionaryWords(input);

  if (!HAS_DICTIONARY) {
    assert.deepEqual(terms, input, "with no dictionary the list passes through");
    assert.equal(dropped, 0);
    return;
  }

  // These are the words that were reported as noise, plus one from the tail that no
  // curated list of UI chrome would ever contain.
  for (const word of ["Three", "Error", "move", "reticent"]) {
    assert.ok(!terms.includes(word), `${word} is English and should be dropped`);
  }
  // A name and an identifier are not in any dictionary.
  for (const word of ["Kubernetes", "Sinead", "api_key"]) {
    assert.ok(terms.includes(word), `${word} should survive`);
  }
  assert.equal(dropped, 4);
});

test("matching ignores case, and the surviving order is preserved", () => {
  const { terms } = lexicon.dropDictionaryWords(["Kubernetes", "ERROR", "Sinead", "Move"]);
  if (!HAS_DICTIONARY) return;

  assert.deepEqual(terms, ["Kubernetes", "Sinead"], "priority order is frequency order");
});

test("empty and malformed input is handled without touching the dictionary", () => {
  assert.deepEqual(lexicon.dropDictionaryWords([]).terms, []);
  assert.deepEqual(lexicon.dropDictionaryWords(null).terms, []);
  assert.deepEqual(lexicon.dropDictionaryWords(undefined).terms, []);
});

test("inflected forms are recognised from their base form", () => {
  // The dictionary lists lemmas, so plurals and participles survived it — and those
  // are most of what a UI is made of. "Files changed", "Commits", "Reviewers" and
  // "approved" were all showing up as candidate vocabulary.
  if (!HAS_DICTIONARY) return;

  for (const word of [
    "Requests",
    "Files",
    "Commits",
    "Checks",
    "Reviewers",
    "approved",
    "changes",
    "changed",
    "helpers",
    "merging",
    "libraries",
    "recently",
  ]) {
    assert.equal(lexicon.isEnglishWord(word), true, `${word} reduces to an English word`);
  }
});

test("stemming does not swallow names", () => {
  // The risk of crude suffix stripping: a name that happens to end in -s or -ed.
  // Over-stemming costs a correction, so it must not reach real vocabulary.
  if (!HAS_DICTIONARY) return;

  for (const word of [
    "Kubernetes",
    "Grafana",
    "Terraform",
    "Sinead",
    "OpenWhispr",
    "Grok",
    "Postgres",
    "Datadog",
  ]) {
    assert.equal(lexicon.isEnglishWord(word), false, `${word} is not English`);
  }
});

test("isEnglishWord answers for single words", () => {
  if (!HAS_DICTIONARY) {
    assert.equal(lexicon.isEnglishWord("error"), false, "no dictionary means no claims");
    return;
  }
  assert.equal(lexicon.isEnglishWord("error"), true);
  assert.equal(lexicon.isEnglishWord("ERROR"), true);
  assert.equal(lexicon.isEnglishWord("Kubernetes"), false);
});
