const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Whether screen context OCR is actually adding latency to a dictation is a question
// this file exists to keep answerable from the stats page rather than from guessing:
// the capture starts before the mic is even acquired (see startRecording), so by the
// time collectScreenContext is asked for it, it should almost always already be done.
// If it isn't, that has to show up as a real number — median/p95 for how long the wait
// typically is, and a drop rate for how often it hits the ceiling with nothing to show.
//
// Recorded through the same recordModelLatency/getModelLatencyStats path every other
// model call uses, under kind "screenContext" — a genuinely new latency series would be
// easy to miss on the stats page; reusing the existing one means it just shows up as one
// more row.

const ROOT = path.join(__dirname, "..", "..");
const audioManager = fs.readFileSync(path.join(ROOT, "src", "helpers", "audioManager.js"), "utf8");
const modelStatsView = fs.readFileSync(
  path.join(ROOT, "src", "components", "ModelStatsView.tsx"),
  "utf8"
);
const enTranslation = fs.readFileSync(
  path.join(ROOT, "src", "locales", "en", "translation.json"),
  "utf8"
);

function collectScreenContextSection() {
  const start = audioManager.indexOf("async collectScreenContext()");
  assert.ok(start > -1, "could not find collectScreenContext — has it moved?");
  const end = audioManager.indexOf("\n  }", audioManager.indexOf("finally {", start));
  return audioManager.slice(start, end);
}

test("a capture that resolves before the budget is timed and recorded as ok", () => {
  const section = collectScreenContextSection();
  assert.match(
    section,
    /recordModelLatency\(\s*"screenContext"[\s\S]{0,120}"ok"/,
    "a successful (or legitimately empty) resolution before the budget must record a timing"
  );
});

test("hitting the collection budget is recorded as dropped, not silently ignored", () => {
  // This is the number that answers "how often are we actually waiting and getting
  // nothing": a version that let the timeout resolve to plain `null` (indistinguishable
  // from collect() itself returning null quickly) would lose this entirely.
  const section = collectScreenContextSection();
  assert.match(
    section,
    /recordModelLatency\(\s*"screenContext"[\s\S]{0,120}"dropped"/,
    "a timeout must be recorded as a dropped call, distinct from a fast empty result"
  );
});

test("the timeout path is distinguishable from collect() itself resolving null", () => {
  // The bug this guards against: racing collect() against a timer that also resolves
  // to `null` on expiry makes "timed out" and "collect() said no" the same value, so
  // there would be nothing to record a "dropped" outcome from in the first place.
  const section = collectScreenContextSection();
  assert.doesNotMatch(
    section,
    /setTimeout\(\(\) => resolve\(null\)/,
    "the timeout must resolve to a distinct sentinel, not null, so it can be told apart"
  );
});

test("screen context stats appear on the model stats page", () => {
  assert.match(
    modelStatsView,
    /const KINDS = \[[^\]]*"screenContext"[^\]]*\]/,
    "screenContext must be one of the tabulated kinds, or the recorded latency is invisible"
  );
});

test("every kind tabulated on the stats page has an English label", () => {
  const kindsMatch = modelStatsView.match(/const KINDS = \[([^\]]*)\]/);
  assert.ok(kindsMatch, "could not read KINDS — has it moved?");
  const kinds = [...kindsMatch[1].matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 2, "sanity check on the parse itself");

  const translation = JSON.parse(enTranslation);
  for (const kind of kinds) {
    assert.ok(
      translation.modelStats?.kinds?.[kind],
      `modelStats.kinds.${kind} is missing from en/translation.json`
    );
  }
});
