const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  resolveMultiSecondWaitMs,
  DEFAULT_MULTI_SECOND_TIMEOUT_MS,
  DEFAULT_MULTI_SECOND_TIMEOUT_PERCENT,
  DEFAULT_MULTI_SECOND_MAX_WAIT_MS,
  MULTI_SECOND_TIMEOUT_PERCENT_CHOICES,
  MULTI_SECOND_MAX_WAIT_CHOICES_MS,
} = require("../../src/config/multiTranscription.ts");

// resolveMultiSecondWaitMs's 4th argument caps the total. Tests below that are about
// the flat-plus-percentage arithmetic itself, not the cap, pass 0 (no cap) explicitly —
// otherwise the default 2500ms cap (added after these were written) would silently
// start truncating results these tests compute by hand and compare against exactly.

// The wait a slow lane gets is a floor plus a share of the recording. The floor is what
// makes a short dictation predictable; the share is what stops a long one dropping lanes
// that were always going to take longer, since the fast/slow spread grows with the audio.
//
// Every input is a stored setting or a measured duration, so the interesting cases are
// the unusable ones: this sits in the paste path, and a budget that came out as 0 would
// drop every lane but the first on every dictation.

test("the flat part is the whole budget when nothing was recorded", () => {
  // A recorder that reported no duration is the normal case for the streaming paths, and
  // the honest answer is the behaviour this replaced.
  assert.equal(resolveMultiSecondWaitMs(1000, 20, null), 1000);
  assert.equal(resolveMultiSecondWaitMs(1000, 20, 0), 1000);
  assert.equal(resolveMultiSecondWaitMs(1000, 20, undefined), 1000);
});

test("the share is added to the floor, not substituted for it", () => {
  assert.equal(resolveMultiSecondWaitMs(1000, 20, 10, 0), 1000 + 2000);
  assert.equal(resolveMultiSecondWaitMs(1000, 20, 60, 0), 1000 + 12000);
  assert.equal(resolveMultiSecondWaitMs(500, 50, 30, 0), 500 + 15000);
});

test("zero percent is the old fixed behaviour, and is not mistaken for unset", () => {
  // 0 is falsy, so a `percent || DEFAULT` fallback would silently restore 20% for anyone
  // who deliberately turned the dynamic part off.
  assert.equal(resolveMultiSecondWaitMs(1000, 0, 300), 1000);
});

test("a flat wait of zero is honoured", () => {
  // Same trap on the other argument: someone who wants the budget to be purely
  // proportional should get that, not the default second.
  assert.equal(resolveMultiSecondWaitMs(0, 20, 10), 2000);
});

test("unusable settings fall back to the defaults rather than to nothing", () => {
  assert.equal(
    resolveMultiSecondWaitMs(undefined, undefined, null),
    DEFAULT_MULTI_SECOND_TIMEOUT_MS
  );
  assert.equal(
    resolveMultiSecondWaitMs(NaN, NaN, 10),
    resolveMultiSecondWaitMs(
      DEFAULT_MULTI_SECOND_TIMEOUT_MS,
      DEFAULT_MULTI_SECOND_TIMEOUT_PERCENT,
      10
    )
  );
  // A negative stored value is not a shorter wait, it is a broken setting. Derived from
  // the constants rather than written out: spelling the arithmetic as a literal made this
  // assertion a second copy of the default, and changing the default broke it.
  assert.equal(
    resolveMultiSecondWaitMs(-5000, -10, 10),
    DEFAULT_MULTI_SECOND_TIMEOUT_MS + DEFAULT_MULTI_SECOND_TIMEOUT_PERCENT * 100
  );
});

test("a duration that is not a number cannot poison the budget", () => {
  assert.equal(resolveMultiSecondWaitMs(1000, 20, "60"), 1000, "a string duration is ignored");
  assert.equal(resolveMultiSecondWaitMs(1000, 20, Infinity), 1000);
  assert.equal(resolveMultiSecondWaitMs(1000, 20, -30), 1000);
});

test("the result is a whole number of milliseconds", () => {
  // It becomes a setTimeout delay; a fractional value is meaningless and reads badly in
  // the log line that reports why a lane was dropped. Uncapped (0), since this is about
  // rounding, not the cap — 1000 + 1554 = 2554 would otherwise be clipped to 2500 by the
  // default cap and the assertion below would be testing the cap, not the rounding.
  assert.equal(Number.isInteger(resolveMultiSecondWaitMs(1000, 20, 7.77, 0)), true);
  assert.equal(resolveMultiSecondWaitMs(1000, 20, 7.77, 0), 1000 + 1554);
});

test("the default is offered in the settings picker", () => {
  // Otherwise the control cannot display the value the app is actually using, and picking
  // anything else would be a one-way door.
  assert.ok(MULTI_SECOND_TIMEOUT_PERCENT_CHOICES.includes(DEFAULT_MULTI_SECOND_TIMEOUT_PERCENT));
  assert.ok(MULTI_SECOND_TIMEOUT_PERCENT_CHOICES.includes(0), "there is no way to turn it off");
});

test("the fan-out asks the resolver rather than reading the setting itself", () => {
  // The regression this guards: audioManager used to inline
  // `Number.isFinite(x) ? x : DEFAULT`, which is exactly the second default the settings
  // rules forbid — and it would have kept the flat-only behaviour while the UI offered a
  // percentage.
  const audioManager = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "helpers", "audioManager.js"),
    "utf8"
  );
  assert.match(
    audioManager,
    /const budgetMs = resolveMultiSecondWaitMs\(/,
    "the slow-lane budget must come from the resolver"
  );
  assert.doesNotMatch(
    audioManager,
    /Number\.isFinite\(settings\.dualTranscriptionSecondTimeoutMs\)/,
    "the flat setting is being read directly again"
  );
  // And the duration has to reach it, or the dynamic part is always zero.
  assert.match(audioManager, /recordingSeconds: metadata\.durationSeconds/);
});

test("percent choices include 5 (the default) and 7.5, and both round-trip", () => {
  assert.ok(MULTI_SECOND_TIMEOUT_PERCENT_CHOICES.includes(5));
  assert.ok(MULTI_SECOND_TIMEOUT_PERCENT_CHOICES.includes(7.5));
  assert.equal(DEFAULT_MULTI_SECOND_TIMEOUT_PERCENT, 5);
});

test("the max is a hard cap on the total, applied by default", () => {
  // With no 4th argument, the default cap (2500ms) applies — this is the behaviour a
  // fresh install gets, and the one place a caller can forget to pass a max at all.
  assert.equal(resolveMultiSecondWaitMs(1000, 20, 10), 2500);
  assert.equal(resolveMultiSecondWaitMs(1000, 50, 300), DEFAULT_MULTI_SECOND_MAX_WAIT_MS);
});

test("zero max means no cap, and is not mistaken for unset", () => {
  // Same trap as percent's 0: a falsy check would restore the default cap for anyone
  // who deliberately turned it off, silently reintroducing the ceiling they removed.
  assert.equal(resolveMultiSecondWaitMs(1000, 50, 300, 0), 1000 + 150000);
});

test("an explicit max below the default is honoured", () => {
  assert.equal(resolveMultiSecondWaitMs(1000, 20, 10, 1500), 1500);
  // Below the raw total: capped. Above it: the cap never lowers a result that was
  // already under it.
  assert.equal(resolveMultiSecondWaitMs(1000, 20, 10, 5000), 3000);
});

test("the max caps the total even when the flat floor alone exceeds it", () => {
  // A max is a ceiling on the whole budget, not just the percentage part — a
  // misconfigured pair (flat higher than max) still gets capped rather than the max
  // being silently ignored because "the floor already accounts for that".
  assert.equal(resolveMultiSecondWaitMs(3000, 0, 0, 2500), 2500);
});

test("an unusable max falls back to the default cap, not to no cap", () => {
  // The dangerous direction to get wrong: unset silently becoming "unbounded" would
  // remove the safety valve the cap exists to be, for anyone whose stored setting was
  // never written (a fresh install) or got corrupted.
  assert.equal(resolveMultiSecondWaitMs(1000, 50, 300, undefined), DEFAULT_MULTI_SECOND_MAX_WAIT_MS);
  assert.equal(resolveMultiSecondWaitMs(1000, 50, 300, NaN), DEFAULT_MULTI_SECOND_MAX_WAIT_MS);
  assert.equal(resolveMultiSecondWaitMs(1000, 50, 300, -1), DEFAULT_MULTI_SECOND_MAX_WAIT_MS);
});

test("the default cap and a way to turn it off are both offered in the settings picker", () => {
  assert.ok(MULTI_SECOND_MAX_WAIT_CHOICES_MS.includes(DEFAULT_MULTI_SECOND_MAX_WAIT_MS));
  assert.ok(MULTI_SECOND_MAX_WAIT_CHOICES_MS.includes(0), "there is no way to turn the cap off");
});

test("the fan-out passes the max setting to the resolver, not just flat and percent", () => {
  // The regression this guards: the cap was added after the resolver call already
  // existed in audioManager, so it is exactly the kind of argument that is easy to wire
  // into the settings store and the UI while forgetting the one place it has to reach.
  const audioManager = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "helpers", "audioManager.js"),
    "utf8"
  );
  const start = audioManager.indexOf("const budgetMs = resolveMultiSecondWaitMs(");
  assert.ok(start > 0, "could not find the resolver call");
  const call = audioManager.slice(start, audioManager.indexOf(");", start));
  assert.match(call, /settings\.dualTranscriptionSecondTimeoutMaxMs/);
});
