const test = require("node:test");
const assert = require("node:assert/strict");

const { planAutoGain, AUTO_GAIN_DEFAULTS } = require("../../src/utils/autoGain.js");

const RATE = 16000;

// Synthetic mono audio. `level` is the amplitude of the speech bursts, so a low level
// is the quiet-microphone case this feature exists for.
function speech(seconds, level, { noise = 0.0002, seed = 1 } = {}) {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  // Deterministic pseudo-noise: a real random() makes a failure impossible to re-run.
  let rnd = seed;
  const next = () => {
    rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
    return rnd / 0x7fffffff - 0.5;
  };
  for (let i = 0; i < n; i++) {
    // 2s of speech, 1s of pause — dictation is mostly pauses, which is what makes a
    // whole-signal RMS the wrong measurement.
    const speaking = (i / RATE) % 3 < 2;
    const t = i / RATE;
    out[i] = speaking ? level * Math.sin(2 * Math.PI * 180 * t) : 0;
    out[i] += next() * noise * 2;
  }
  return out;
}

function silence(seconds) {
  return new Float32Array(Math.round(seconds * RATE));
}

test("quiet speech is boosted toward the target level", () => {
  const plan = planAutoGain(speech(6, 0.02), RATE);

  assert.equal(plan.applied, true, plan.reason);
  assert.ok(plan.gain > 1, "quiet audio must be amplified");
  // The point of the feature: after gain the speech should sit near the target, not
  // merely somewhat louder than it was.
  const resultingRms = plan.speechRms * plan.gain;
  assert.ok(
    resultingRms > AUTO_GAIN_DEFAULTS.targetRms * 0.5,
    `speech ended up at ${resultingRms.toFixed(3)}, far short of the target`
  );
});

test("audio already at a healthy level is left alone", () => {
  // A no-op has to be the common case, or this feature is a permanent tax on every
  // recording that was already fine.
  const plan = planAutoGain(speech(6, 0.25), RATE);

  assert.equal(plan.applied, false);
  assert.equal(plan.gain, 1);
  assert.ok(
    plan.reason === "already-loud-enough" || plan.reason === "change-too-small",
    `unexpected reason: ${plan.reason}`
  );
});

test("gain is never below 1 — this boosts, it never attenuates", () => {
  // Turning audio down cannot repair clipping and can only make a working recording
  // worse, so loud input must come back as exactly 1.
  for (const level of [0.3, 0.6, 0.9, 1.0]) {
    const plan = planAutoGain(speech(4, level), RATE);
    assert.ok(plan.gain >= 1, `level ${level} produced attenuation: ${plan.gain}`);
  }
});

test("silence is skipped rather than amplified into noise", () => {
  const plan = planAutoGain(silence(3), RATE);
  assert.equal(plan.applied, false);
  assert.equal(plan.gain, 1);
  assert.equal(plan.reason, "silent");
});

test("a near-dead microphone is capped, not amplified without limit", () => {
  // Boosting a noise floor by 500x delivers loud hiss, which recognizers happily
  // hallucinate words into. The cap is the guard against that.
  const plan = planAutoGain(speech(4, 0.0008, { noise: 0.0006 }), RATE);
  assert.ok(plan.gain <= AUTO_GAIN_DEFAULTS.maxGain, `gain ${plan.gain} exceeded the cap`);
});

test("one loud transient does not pin the gain at 1", () => {
  // The noisy-desk case, and the reason the peak is a percentile rather than a true
  // maximum: a single keyboard click at full scale would otherwise consume all the
  // headroom and leave the quiet speech exactly as quiet as it was.
  const samples = speech(6, 0.02);
  samples[Math.floor(samples.length / 2)] = 0.98;
  samples[Math.floor(samples.length / 2) + 1] = -0.97;

  const plan = planAutoGain(samples, RATE);

  assert.equal(plan.applied, true, plan.reason);
  assert.ok(plan.gain > 2, `a lone transient suppressed the gain to ${plan.gain}`);
});

test("the measured peak keeps headroom below full scale", () => {
  // Applied gain must not drive the measured peak past maxPeak; the encoder clamps the
  // rare overshoot above it, but the bulk of the signal should not be relying on that.
  const plan = planAutoGain(speech(6, 0.05), RATE);
  if (!plan.applied) return;
  assert.ok(
    plan.peak * plan.gain <= AUTO_GAIN_DEFAULTS.maxPeak + 1e-6,
    `peak would reach ${(plan.peak * plan.gain).toFixed(3)}, above maxPeak`
  );
});

test("empty and malformed input is skipped without throwing", () => {
  for (const [samples, rate] of [
    [new Float32Array(0), RATE],
    [null, RATE],
    [undefined, RATE],
    [speech(1, 0.02), 0],
    [speech(1, 0.02), -1],
    [speech(1, 0.02), NaN],
  ]) {
    const plan = planAutoGain(samples, rate);
    assert.equal(plan.applied, false);
    assert.equal(plan.gain, 1);
  }
});

test("the work examined is bounded, so cost does not grow with recording length", () => {
  // This is the performance contract, not a detail: measuring every window cost 12.8ms
  // on a five-minute recording, over the budget this feature was allowed. Capping the
  // examined windows is what keeps the decision near-constant-time.
  const short = planAutoGain(speech(5, 0.02), RATE);
  const long = planAutoGain(speech(300, 0.02), RATE);

  assert.ok(
    long.windowsExamined <= AUTO_GAIN_DEFAULTS.maxWindows,
    `examined ${long.windowsExamined} windows, above the cap`
  );
  assert.ok(
    long.windowsExamined <= short.windowsExamined * 3,
    "a 60x longer recording must not examine proportionally more windows"
  );
});

test("a level change partway through is still seen", () => {
  // The examined windows are strided across the whole recording rather than taken from
  // the front, so someone who starts close to the mic and drifts away is measured on
  // both halves. Sampling only the beginning would read this as loud and do nothing.
  const loudFirst = speech(60, 0.25);
  const quiet = speech(60, 0.015);
  const drifting = new Float32Array(loudFirst.length + quiet.length);
  drifting.set(loudFirst, 0);
  drifting.set(quiet, loudFirst.length);

  const plan = planAutoGain(drifting, RATE);

  // The loud half legitimately limits how much gain is safe, so the assertion is that
  // the quiet half was seen at all — the speech percentile sits below the loud half's
  // level rather than at it.
  assert.ok(
    plan.speechRms < 0.25 * 0.707,
    `speech level ${plan.speechRms.toFixed(4)} ignored the quiet half`
  );
});

test("a plan reports why it did nothing, for every skip path", () => {
  // A silent no-op is indistinguishable from the feature never running, which is how a
  // regression here would go unnoticed.
  for (const plan of [
    planAutoGain(new Float32Array(0), RATE),
    planAutoGain(silence(2), RATE),
    planAutoGain(speech(4, 0.4), RATE),
  ]) {
    assert.equal(plan.applied, false);
    assert.ok(typeof plan.reason === "string" && plan.reason.length > 0, "missing reason");
  }
});

// --- wiring, checked statically ---
//
// encodeWavPcm16 and prepareAudioForUpload live inside audioManager.js, which imports
// browser globals and cannot be loaded in a plain node test. These are text checks on
// the seams instead, which is how the rest of this repo guards that file.

const fs = require("fs");
const path = require("path");
const audioManager = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "helpers", "audioManager.js"),
  "utf8"
);

test("the gain is multiplied inside the encoder's clamp, not outside it", () => {
  // Outside the clamp, an amplified sample above full scale wraps to the opposite sign
  // in setInt16 — silent, catastrophic distortion on exactly the loudest moments.
  assert.match(
    audioManager,
    /Math\.max\(-1, Math\.min\(1, samples\[i\] \* gain\)\)/,
    "the gain must be applied within the clamp so an overshoot saturates instead of wrapping"
  );
});

test("gain reaches the encoder from the plan, with no second apply pass", () => {
  assert.match(
    audioManager,
    /function encodeWavPcm16\(samples, sampleRate, gain = 1\)/,
    "the encoder must take a gain, defaulting to a no-op for any other caller"
  );
  assert.match(
    audioManager,
    /encodeWavPcm16\(resampled\.samples, resampled\.sampleRate, gainPlan\.gain\)/,
    "the upload path must pass the planned gain"
  );
  // A separate apply pass was measured at 5.5ms on a five-minute recording, which alone
  // would have exceeded the budget this feature was allowed.
  assert.doesNotMatch(
    audioManager,
    /applyAutoGain/,
    "gain must be folded into the encoder loop, not applied in a pass of its own"
  );
});

test("the level is measured after the trim and the resample", () => {
  // After the resample: the level is measured on exactly the samples uploaded, and on
  // the fewest of them. After the trim: the trim's adaptive threshold was tuned against
  // original levels, so amplifying first would quietly change what it cuts.
  const trimAt = audioManager.indexOf("planSilenceTrim(");
  const resampleAt = audioManager.indexOf("await resampleForUpload(samples");
  const gainAt = audioManager.indexOf("planAutoGain(resampled.samples");

  assert.ok(trimAt > 0 && resampleAt > 0 && gainAt > 0, "could not find the upload path");
  assert.ok(gainAt > trimAt, "gain must be measured after the silence trim");
  assert.ok(gainAt > resampleAt, "gain must be measured after the resample");
});

test("the setting can turn gain off, and absent means the default", () => {
  // `=== false`, not a truthy check: an absent setting must resolve to the store's
  // default rather than silently meaning off, which is the second-default bug this
  // repo's settingsDefaults guard exists for.
  assert.match(
    audioManager,
    /trimSettings\.autoGainEnabled === false/,
    "the check must be strict, or an unset value reads as disabled"
  );
  // Disabled must be a real no-op: gain exactly 1 and a reason, so the log can tell
  // "switched off" apart from "nothing to raise".
  assert.match(
    audioManager,
    /\{ gain: 1, applied: false, speechRms: 0, reason: "disabled" \}/,
    "disabling must produce a unity-gain plan with a stated reason"
  );
  // And the disabled path must not call the planner at all — measuring and then
  // discarding the result would keep paying for a feature that is switched off.
  const start = audioManager.indexOf("const gainPlan =");
  const decision = audioManager.slice(start, start + 260);
  assert.ok(
    decision.indexOf("autoGainEnabled === false") < decision.indexOf("planAutoGain("),
    "the setting must be checked before the planner runs"
  );
});

test("the default is on, declared once, and reachable from the store", () => {
  const { DEFAULT_AUTO_GAIN_ENABLED } = require("../../src/utils/autoGain.js");
  assert.equal(DEFAULT_AUTO_GAIN_ENABLED, true, "a quiet recording should be fixed by default");

  const store = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "stores", "settingsStore.ts"),
    "utf8"
  );
  assert.match(
    store,
    /readBoolean\("autoGainEnabled", DEFAULT_AUTO_GAIN_ENABLED\)/,
    "the store must seed from the shared constant, not a literal"
  );
});

test("the toggle is rendered where the other audio settings are", () => {
  // A setting with no control is a setting nobody can use — the same gap that left the
  // Soniox key unenterable.
  const settingsPage = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "components", "SettingsPage.tsx"),
    "utf8"
  );
  assert.match(settingsPage, /checked=\{autoGainEnabled\} onChange=\{setAutoGainEnabled\}/);
  assert.match(settingsPage, /settingsPage\.transcription\.autoGain/);

  const strings = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "locales", "en", "translation.json"),
      "utf8"
    )
  );
  assert.ok(strings.settingsPage.transcription.autoGain, "the label needs a string");
  assert.ok(strings.settingsPage.transcription.autoGainDescription, "and a description");
});
