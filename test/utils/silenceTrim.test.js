const test = require("node:test");
const assert = require("node:assert/strict");

const {
  planSilenceTrim,
  applySilenceTrim,
  SILENCE_TRIM_DEFAULTS,
} = require("../../src/utils/silenceTrim.js");

const RATE = 16000;

// Builders for synthetic mono audio, in seconds.
const silence = (seconds) => new Float32Array(Math.round(seconds * RATE));
function tone(seconds, amplitude = 0.3) {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++)
    out[i] = Math.sin((i / RATE) * 2 * Math.PI * 220) * amplitude;
  return out;
}
function concat(...parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
const seconds = (samples) => samples / RATE;

test("empty or degenerate input is left alone", () => {
  assert.equal(planSilenceTrim(new Float32Array(0), RATE).trimmed, false);
  assert.equal(planSilenceTrim(null, RATE).trimmed, false);
  assert.equal(planSilenceTrim(tone(1), 0).trimmed, false);
  // Under three windows there is nothing meaningful to analyse.
  assert.equal(planSilenceTrim(tone(0.02), RATE).reason, "too short");
});

test("leading and trailing silence is trimmed", () => {
  const audio = concat(silence(2), tone(1), silence(2));
  const plan = planSilenceTrim(audio, RATE);
  assert.equal(plan.trimmed, true);
  assert.equal(plan.segments.length, 1);

  // The speech survives, plus padding either side, and little else.
  const kept = seconds(plan.keptSamples);
  assert.ok(kept > 1, `kept ${kept}s, expected more than the 1s of speech`);
  assert.ok(kept < 1.5, `kept ${kept}s, expected padding not the full 5s`);
});

test("a long mid-recording pause is shortened, not removed", () => {
  const audio = concat(tone(0.5), silence(3), tone(0.5));
  const plan = planSilenceTrim(audio, RATE);
  assert.equal(plan.segments.length, 2, "speech either side of the pause");

  // Some gap must survive, or the recognizer runs the words together.
  const gapMs = (plan.gapSamples / RATE) * 1000;
  assert.equal(gapMs, SILENCE_TRIM_DEFAULTS.maxGapMs);
  assert.ok(gapMs > 0, "a pause is preserved");

  const output = applySilenceTrim(audio, plan);
  assert.ok(
    seconds(output.length) < seconds(audio.length),
    "the result is shorter than the original"
  );
});

test("a short gap between words is not cut at all", () => {
  // 120ms is shorter than the padding either side, so the words stay joined.
  const audio = concat(tone(0.4), silence(0.12), tone(0.4));
  const plan = planSilenceTrim(audio, RATE);
  assert.equal(plan.segments.length, 1, "one continuous segment");
});

test("continuous speech is left essentially intact", () => {
  const audio = tone(3);
  const plan = planSilenceTrim(audio, RATE);
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.keptSamples, audio.length);
});

test("audio that is silence throughout is handed back untouched", () => {
  // The speech gate reports "no audio detected" to the user; returning an empty
  // buffer here would instead look like a transcription failure.
  const plan = planSilenceTrim(silence(3), RATE);
  assert.equal(plan.trimmed, false);
  assert.equal(plan.reason, "no speech");
  assert.equal(plan.keptSamples, 3 * RATE);
});

test("a mostly-silent recording is trimmed hard rather than left alone", () => {
  // The case trimming exists for: key pressed early, one short word, released
  // late. There is no floor on how much may be cut.
  const audio = concat(silence(10), tone(0.4), silence(10));
  const plan = planSilenceTrim(audio, RATE);
  assert.equal(plan.trimmed, true);
  assert.ok(
    seconds(plan.keptSamples) < 1.5,
    `kept ${seconds(plan.keptSamples)}s of 20.4s, expected roughly the speech`
  );
});

test("quiet speech below the threshold is not mistaken for silence", () => {
  // Amplitude just above the threshold must still register as speech.
  const audio = concat(silence(1), tone(1, 0.02), silence(1));
  const plan = planSilenceTrim(audio, RATE);
  assert.notEqual(plan.reason, "no speech");
  assert.equal(plan.trimmed, true);
});

test("applying a plan preserves the speech samples in order", () => {
  const audio = concat(tone(0.3), silence(2), tone(0.3));
  const plan = planSilenceTrim(audio, RATE);
  const output = applySilenceTrim(audio, plan);

  const expected =
    plan.segments.reduce((sum, [s, e]) => sum + (e - s), 0) +
    plan.gapSamples * (plan.segments.length - 1);
  assert.equal(output.length, expected);

  // The gap region is silent, and the audio around it is not.
  const [firstStart, firstEnd] = plan.segments[0];
  const firstLen = firstEnd - firstStart;
  assert.equal(output[firstLen + Math.floor(plan.gapSamples / 2)], 0);
  assert.ok(
    output.some((v) => Math.abs(v) > 0.1),
    "speech survived"
  );
});

test("a realistic noise floor is still treated as silence", () => {
  // The bug this fixes: a fixed 0.003 threshold marked ordinary mic self-noise
  // as speech, so nothing was ever trimmed on a real recording.
  const noise = (secs, amp = 0.01) => {
    const out = new Float32Array(Math.round(secs * RATE));
    for (let i = 0; i < out.length; i++) out[i] = (Math.random() * 2 - 1) * amp;
    return out;
  };
  const audio = concat(noise(2), tone(1), noise(2));
  const plan = planSilenceTrim(audio, RATE);
  assert.equal(plan.trimmed, true, `expected a trim, got ${plan.reason}`);
  assert.ok(
    seconds(plan.keptSamples) < 2,
    `kept ${seconds(plan.keptSamples)}s of 5s, expected roughly the 1s of speech`
  );
});

test("a skip always reports a reason", () => {
  // An empty reason made a field skip undiagnosable from the log.
  assert.ok(planSilenceTrim(tone(3), RATE).reason, "continuous speech reports why");
  assert.ok(planSilenceTrim(silence(3), RATE).reason);
  assert.ok(planSilenceTrim(new Float32Array(0), RATE).reason);
});

test("an untouched plan round-trips to the identical buffer", () => {
  const audio = tone(1);
  const plan = planSilenceTrim(audio, RATE);
  const output = applySilenceTrim(audio, plan);
  assert.deepEqual(Array.from(output), Array.from(audio));
});
