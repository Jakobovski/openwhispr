const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const load = () => import("../../src/stores/screenContextTerms.ts");

const ROOT = path.join(__dirname, "..", "..");

test("terms are returned for the dictation that recorded them", async () => {
  const { recordScreenTerms, getScreenTerms, clearScreenTerms } = await load();
  clearScreenTerms();

  recordScreenTerms("abc", { window: "Safari — PR", terms: ["OpenWhispr"], termCount: 1 });

  assert.deepEqual(getScreenTerms("abc"), {
    window: "Safari — PR",
    terms: ["OpenWhispr"],
    termCount: 1,
  });
  assert.equal(getScreenTerms("other"), null, "no bleed between dictations");
  assert.equal(getScreenTerms(undefined), null);
  assert.equal(getScreenTerms(null), null);
});

test("a dictation with no id records nothing rather than colliding", async () => {
  const { recordScreenTerms, getScreenTerms, clearScreenTerms } = await load();
  clearScreenTerms();

  recordScreenTerms(undefined, { window: "W", terms: ["A"], termCount: 1 });
  recordScreenTerms("", { window: "W", terms: ["B"], termCount: 1 });

  assert.equal(getScreenTerms(""), null);
  assert.equal(getScreenTerms(undefined), null);
});

test("the store is bounded, dropping the oldest dictations first", async () => {
  const { recordScreenTerms, getScreenTerms, clearScreenTerms } = await load();
  clearScreenTerms();

  // Well past the cap, so the earliest entries must be gone and the latest kept.
  for (let i = 0; i < 260; i++) {
    recordScreenTerms(`id-${i}`, { window: "W", terms: [`term-${i}`], termCount: 1 });
  }

  assert.equal(getScreenTerms("id-0"), null, "oldest evicted");
  assert.deepEqual(getScreenTerms("id-259")?.terms, ["term-259"], "newest kept");
});

test("only the replacements are persisted, never the OCR'd terms", () => {
  // An explicit requirement, not a preference: the candidate vocabulary is the
  // contents of whatever window the user was dictating into, and it must not reach
  // the database — which also means it must not reach the cloud sync that carries
  // transcription rows. The corrections are fine to store, because the corrected
  // word is already in the saved transcript by definition.
  const source = fs.readFileSync(path.join(ROOT, "src", "helpers", "audioManager.js"), "utf8");

  // Catches the shape this regressed from, wherever it is written: serialising the
  // whole screen-context object carries the terms and the window title with it.
  assert.doesNotMatch(
    source,
    /JSON\.stringify\(\s*screenContext\s*\)/,
    "the whole screen context object must never be serialised"
  );

  const assignment = source.match(/const screenContextJson =[\s\S]{0,500}?;\n/);
  assert.ok(assignment, "could not find where screen context is serialised for storage");

  const serialised = assignment[0];
  assert.match(serialised, /replacements/, "the corrections should be stored");
  assert.doesNotMatch(serialised, /\bterms\b/, "the OCR'd terms must not be serialised");
  assert.doesNotMatch(serialised, /\bwindow\b/, "the window title must not be serialised");
  assert.doesNotMatch(
    serialised,
    /JSON\.stringify\(\s*screenContext\s*\)/,
    "stringifying the whole object would carry the terms with it"
  );
});
