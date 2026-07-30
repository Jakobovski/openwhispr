// Plans which parts of a recording to keep, so silence is not uploaded.
//
// Providers bill by audio duration, and in dual mode every pause is paid for
// twice. Dictation is mostly pauses: thinking, breathing, the gap between
// pressing the key and speaking.
//
// The plan is deliberately conservative. Removing audio is destructive and
// unverifiable after the fact — if a word is clipped, the user sees a wrong
// transcript with no clue why. So speech is padded on both sides before
// cutting, gaps are shortened rather than removed (a recognizer needs a pause
// to place a word boundary), and anything that looks like over-trimming
// abandons the plan and keeps the original.

const DEFAULTS = {
  // Short enough to catch a gap between words, long enough that RMS is stable.
  windowMs: 20,
  // Floor for the adaptive threshold. A fixed value cannot work across
  // microphones: a real noise floor sits anywhere from 0.005 to 0.02 RMS, so a
  // low fixed threshold marks the whole recording as speech and trims nothing.
  minThresholdRms: 0.004,
  // The noise floor is taken as this percentile of window loudness, then scaled.
  noiseFloorPercentile: 0.2,
  noiseFloorMultiple: 2.5,
  // Also require a fraction of the recording's own peak, so a quiet room does
  // not make faint noise look like speech.
  peakFraction: 0.05,
  // Kept either side of speech so a soft consonant is not clipped off.
  paddingMs: 80,
  // The pause left where a longer silence was cut. Some gap has to survive:
  // splicing words flush together makes a recognizer run them into one.
  maxGapMs: 220,
};

function rms(samples, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

/**
 * Decide what to keep.
 *
 * @param {Float32Array|number[]} samples - Mono PCM in [-1, 1]
 * @param {number} sampleRate
 * @param {object} [options] - Overrides for DEFAULTS
 * @returns {{segments: Array<[number, number]>, gapSamples: number, trimmed: boolean,
 *            keptSamples: number, totalSamples: number, reason?: string}}
 */
function planSilenceTrim(samples, sampleRate, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const total = samples?.length || 0;
  const untouched = (reason) => ({
    segments: total > 0 ? [[0, total]] : [],
    gapSamples: 0,
    trimmed: false,
    keptSamples: total,
    totalSamples: total,
    reason,
  });

  if (!total || !sampleRate) return untouched("empty");

  const windowSamples = Math.max(1, Math.round((opts.windowMs / 1000) * sampleRate));
  const windowCount = Math.ceil(total / windowSamples);
  if (windowCount < 3) return untouched("too short");

  const levels = new Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    const start = w * windowSamples;
    levels[w] = rms(samples, start, Math.min(total, start + windowSamples));
  }

  // Adaptive: derived from this recording's own noise floor and peak, so the
  // same code works on a quiet headset and a noisy room.
  const sorted = [...levels].sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * opts.noiseFloorPercentile)] || 0;
  const peak = sorted[sorted.length - 1] || 0;
  const threshold = Math.max(
    opts.minThresholdRms,
    noiseFloor * opts.noiseFloorMultiple,
    peak * opts.peakFraction
  );

  const voiced = levels.map((level) => level >= threshold);

  // Pad outward from every voiced window. Done as a separate pass so padding
  // never chains: an isolated blip does not drag in its neighbours' neighbours.
  const padWindows = Math.max(1, Math.round(opts.paddingMs / opts.windowMs));
  const keep = new Array(windowCount).fill(false);
  let anyVoiced = false;
  for (let w = 0; w < windowCount; w++) {
    if (!voiced[w]) continue;
    anyVoiced = true;
    const from = Math.max(0, w - padWindows);
    const to = Math.min(windowCount - 1, w + padWindows);
    for (let k = from; k <= to; k++) keep[k] = true;
  }

  // Silence throughout is the speech gate's business, not ours — it can tell the
  // user nothing was heard, whereas we would hand back an empty recording.
  if (!anyVoiced) return untouched("no speech");

  const segments = [];
  let runStart = -1;
  for (let w = 0; w < windowCount; w++) {
    if (keep[w] && runStart === -1) runStart = w;
    if (!keep[w] && runStart !== -1) {
      segments.push([runStart * windowSamples, Math.min(total, w * windowSamples)]);
      runStart = -1;
    }
  }
  if (runStart !== -1) segments.push([runStart * windowSamples, total]);

  // No floor on how much may be cut. A recording that is mostly silence with one
  // short utterance is exactly where trimming pays most, and refusing to trim
  // there uploaded the silence in full.
  const keptSamples = segments.reduce((sum, [start, end]) => sum + (end - start), 0);

  const trimmed = segments.length > 1 || keptSamples < total;
  return {
    segments,
    gapSamples: Math.round((opts.maxGapMs / 1000) * sampleRate),
    trimmed,
    keptSamples,
    totalSamples: total,
    threshold,
    // Always set, so a skip is never logged as an empty object.
    ...(trimmed ? {} : { reason: "nothing to trim" }),
  };
}

/**
 * Splice a plan into a new buffer, separating segments by the planned gap.
 *
 * @param {Float32Array|number[]} samples
 * @param {{segments: Array<[number, number]>, gapSamples: number}} plan
 * @param {Function} [Alloc] - Array constructor, for testing without Float32Array
 * @returns {Float32Array|number[]}
 */
function applySilenceTrim(samples, plan, Alloc = Float32Array) {
  const { segments, gapSamples } = plan;
  if (!segments || segments.length === 0) return new Alloc(0);

  const speech = segments.reduce((sum, [start, end]) => sum + (end - start), 0);
  const gaps = gapSamples * Math.max(0, segments.length - 1);
  const out = new Alloc(speech + gaps);

  let offset = 0;
  segments.forEach(([start, end], index) => {
    for (let i = start; i < end; i++) out[offset++] = samples[i];
    // Leave the gap as zeroes; a synthesised pause is what the recognizer needs
    // for a word boundary, and it is cheaper than the original silence.
    if (index < segments.length - 1) offset += gapSamples;
  });
  return out;
}

// Presets rather than raw RMS numbers: a percentile multiplier is not something
// a user can reason about, but "how much do you want cut" is.
//
// Light is the default. Over-trimming clips words and shows up as a wrong
// transcript with no explanation, while under-trimming only costs a little
// provider time — so the timid end is the safe default.
const SILENCE_TRIM_PRESETS = {
  light: {
    noiseFloorMultiple: 1.5,
    peakFraction: 0.02,
    paddingMs: 160,
    maxGapMs: 350,
  },
  balanced: {
    noiseFloorMultiple: 2.5,
    peakFraction: 0.05,
    paddingMs: 80,
    maxGapMs: 220,
  },
  aggressive: {
    noiseFloorMultiple: 3.5,
    peakFraction: 0.08,
    paddingMs: 50,
    maxGapMs: 150,
  },
};

function resolveSilenceTrimOptions(strength) {
  return SILENCE_TRIM_PRESETS[strength] || SILENCE_TRIM_PRESETS.light;
}

module.exports = {
  planSilenceTrim,
  applySilenceTrim,
  resolveSilenceTrimOptions,
  SILENCE_TRIM_PRESETS,
  SILENCE_TRIM_DEFAULTS: DEFAULTS,
};
