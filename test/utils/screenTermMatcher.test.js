const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractScreenTerms,
  applyScreenTermCorrections,
} = require("../../src/utils/screenTermMatcher.js");

const apply = (transcript, terms) => applyScreenTermCorrections(transcript, terms).text;

test("empty and malformed inputs are passed through untouched", () => {
  assert.deepEqual(extractScreenTerms(null), []);
  assert.deepEqual(extractScreenTerms(""), []);
  assert.deepEqual(extractScreenTerms(12345), []);
  assert.equal(apply("hello world", []), "hello world");
  assert.equal(apply("hello world", null), "hello world");
  assert.equal(apply("", ["Anything"]), "");
});

test("extraction keeps distinctive terms and drops chrome", () => {
  const terms = extractScreenTerms("Open the File menu and click Save to use OpenWhispr");
  assert.ok(terms.includes("OpenWhispr"));
  // Common UI words are not candidate vocabulary.
  for (const word of ["Open", "File", "menu", "click", "Save", "use"]) {
    assert.ok(!terms.includes(word), `${word} should not be a term`);
  }
});

test("extraction drops ordinary English and UI chrome", () => {
  // Reported as noise: the filter was a 204-word list, and every branch of
  // isDistinctiveTerm returned true, so the shape checks gated nothing. These are
  // the exact words that leaked, plus the modern vocabulary the system dictionary
  // predates and therefore cannot catch on its own.
  const terms = extractScreenTerms(`
    Three Error move message account folder Settings Download Inbox Online
    username password dashboard timeline notification Kubernetes Sinead
  `);

  for (const word of [
    "Three",
    "Error",
    "move",
    "message",
    "account",
    "folder",
    "Settings",
    "Download",
    "Inbox",
    "Online",
    "username",
    "password",
    "dashboard",
    "timeline",
    "notification",
  ]) {
    assert.ok(!terms.includes(word), `${word} is chrome and should not be a term`);
  }

  assert.deepEqual(terms, ["Kubernetes", "Sinead"], "only the distinctive terms remain");
});

test("an identifier is kept even when it spells an ordinary word", () => {
  // The shape is the signal, and it has to survive *both* filter stages: the curated
  // lists here, and the system dictionary applied afterwards in the main process.
  // "Rust" is an ordinary word and only the dictionary knows it — which is exactly
  // why the two stages exist — while "RustLang" and "rust-analyzer" are names a
  // recognizer will mangle and neither stage may touch.
  const { dropDictionaryWords } = require("../../src/helpers/englishLexicon");

  const candidates = extractScreenTerms("Rust RustLang rust-analyzer gpt5 s3bucket");
  for (const word of ["RustLang", "rust-analyzer", "gpt5", "s3bucket"]) {
    assert.ok(candidates.includes(word), `${word} should survive extraction`);
  }

  const { terms, available } = dropDictionaryWords(candidates);
  for (const word of ["RustLang", "rust-analyzer", "gpt5", "s3bucket"]) {
    assert.ok(terms.includes(word), `${word} should survive the dictionary too`);
  }
  if (available) {
    assert.ok(!terms.includes("Rust"), "the bare word is ordinary English");
  }
});

test("extraction keeps identifiers and short-circuits tiny tokens", () => {
  const terms = extractScreenTerms("api_key s3 bucket kubernetes-admin v2 x");
  assert.ok(terms.includes("api_key"));
  assert.ok(terms.includes("kubernetes-admin"));
  // Under the 4-char floor.
  assert.ok(!terms.includes("s3"));
  assert.ok(!terms.includes("v2"));
  assert.ok(!terms.includes("x"));
});

test("extraction strips surrounding punctuation but keeps internal", () => {
  const terms = extractScreenTerms('("OpenWhispr"), [api_key];');
  assert.ok(terms.includes("OpenWhispr"));
  assert.ok(terms.includes("api_key"));
});

test("extraction prefers a mixed-case form and dedupes case-insensitively", () => {
  const terms = extractScreenTerms("openwhispr OpenWhispr OPENWHISPR openwhispr");
  const hits = terms.filter((t) => t.toLowerCase() === "openwhispr");
  assert.equal(hits.length, 1, "one entry per distinct word");
  assert.equal(hits[0], "OpenWhispr", "cased form wins");
});

test("extraction orders by frequency and caps the list", () => {
  const text = ["Kubernetes Kubernetes Kubernetes", "Terraform Terraform", "Grafana"].join(" ");
  const terms = extractScreenTerms(text);
  assert.deepEqual(terms.slice(0, 3), ["Kubernetes", "Terraform", "Grafana"]);

  // The cap is a guard against a pathological window, not a quality filter — a
  // dense window legitimately yields hundreds of terms and all of them are kept.
  const many = Array.from({ length: 900 }, (_, i) => `Distinctive${i}`).join(" ");
  assert.equal(extractScreenTerms(many).length, 900, "hundreds of terms are all kept");

  const pathological = Array.from({ length: 6000 }, (_, i) => `Distinctive${i}`).join(" ");
  assert.equal(extractScreenTerms(pathological).length, 5000, "but the list is still bounded");
});

// --- Tier 1: recasing, which is semantically a no-op ---

test("a case-only miss adopts the on-screen casing", () => {
  // Internal capitals only — see the first-letter test below. Nothing about being a
  // button makes the H in GitHub uppercase, so that casing belongs to the word and is
  // taken whole, leading capital included.
  assert.equal(apply("i pushed to github today", ["GitHub"]), "i pushed to GitHub today");
  assert.equal(apply("open openwhispr please", ["OpenWhispr"]), "open OpenWhispr please");
});

test("a first-letter-only capital is not adopted", () => {
  // Screen text capitalises the first word of every label, button and heading, so that
  // capital belongs to the word's position on screen, not to the word. Adopting it
  // capitalised ordinary prose mid-sentence: "rebuild the dataset" came back as
  // "rebuild the Dataset".
  assert.equal(apply("rebuild the dataset", ["Dataset"]), "rebuild the dataset");
  assert.equal(apply("deploy to kubernetes", ["Kubernetes"]), "deploy to kubernetes");
  assert.deepEqual(applyScreenTermCorrections("rebuild the dataset", ["Dataset"]).replacements, []);
});

test("recasing preserves surrounding punctuation", () => {
  const result = apply("Ship it to (github), okay?", ["GitHub"]);
  assert.equal(result, "Ship it to (GitHub), okay?");
});

test("an already-correct term is left exactly as-is", () => {
  const { text, replacements } = applyScreenTermCorrections("Deploy to GitHub", ["GitHub"]);
  assert.equal(text, "Deploy to GitHub");
  assert.deepEqual(replacements, []);
});

// --- Tier 2: speculative substitution, where the risk lives ---

test("a phonetic mishearing of an on-screen name is corrected", () => {
  const { text, replacements } = applyScreenTermCorrections("Email Shunade about it", ["Sinead"]);
  assert.equal(text, "Email Sinead about it");
  assert.deepEqual(replacements, [{ from: "Shunade", to: "Sinead", kind: "substitute" }]);
});

test("a real English word is never replaced by a lookalike on screen", () => {
  // The canonical false positive: "from" must survive a screen full of "Form".
  assert.equal(apply("a note from the team", ["Form"]), "a note from the team");
  assert.equal(apply("fill in the form", ["Form"]), "fill in the form");
  assert.equal(apply("open the file", ["Fila"]), "open the file");
});

test("an unrelated word is not substituted even when phonetically bucketed", () => {
  // Distant enough that the edit-distance ceiling must reject it.
  assert.equal(apply("discuss telemetry later", ["Telluride"]), "discuss telemetry later");
  assert.equal(apply("check the dashboard", ["Dishwasher"]), "check the dashboard");
});

test("an ambiguous phonetic key is skipped rather than guessed", () => {
  // "Smith" and "Smyth" collapse to the same phonetic key, so picking either
  // would be a coin flip — leave the transcript alone.
  assert.equal(apply("email Smithe today", ["Smith", "Smyth"]), "email Smithe today");
  // With only one of them on screen there is no ambiguity to resolve.
  assert.equal(apply("email Smithe today", ["Smyth"]), "email Smyth today");
});

test("prose is not recased just because a UI button shares the word", () => {
  // "Pull Requests" on screen must not capitalise "pull request" in the transcript.
  assert.equal(apply("open a pull request", ["Pull", "Requests"]), "open a pull request");
});

test("substitution respects the length floor", () => {
  // "cat" is under MIN_TERM_LENGTH, so it is never a substitution target.
  assert.equal(apply("the cat sat", ["Kat"]), "the cat sat");
});

test("multiple corrections in one transcript are all reported", () => {
  const { text, replacements } = applyScreenTermCorrections("push to github and ping Shunade", [
    "GitHub",
    "Sinead",
  ]);
  assert.equal(text, "push to GitHub and ping Sinead");
  assert.equal(replacements.length, 2);
  assert.deepEqual(
    replacements.map((r) => r.kind),
    ["recase", "substitute"]
  );
});

test("every replacement's new word is one of the supplied screen terms", () => {
  // The history view marks which candidate terms were actually used by matching
  // each replacement's `to` against the term list. That only works because a
  // replacement can never introduce a word from outside the list — it either
  // recases an exact hit or swaps in a phonetic match, both drawn from the terms.
  const terms = extractScreenTerms(`
    OpenWhispr/openwhispr Kubernetes api_key Sinead Terraform
  `);
  const { replacements } = applyScreenTermCorrections(
    "push to openwhispr and ping Shunade about kubernetes",
    terms
  );

  assert.ok(replacements.length > 0, "expected this transcript to be corrected");
  const lowered = new Set(terms.map((term) => term.toLowerCase()));
  for (const replacement of replacements) {
    assert.ok(
      lowered.has(replacement.to.toLowerCase()),
      `"${replacement.to}" is not one of the screen terms`
    );
  }
});

test("end to end: OCR text drives the correction", () => {
  const ocr = `
    Pull Requests · OpenWhispr/openwhispr
    #1383 feat(xai): stream Grok STT over websockets
    Reviewers: Sinead
  `;
  const terms = extractScreenTerms(ocr);
  const { text } = applyScreenTermCorrections(
    "ask Shunade to review the openwhispr pull request",
    terms
  );
  assert.match(text, /Sinead/);
  assert.match(text, /OpenWhispr/);
});
