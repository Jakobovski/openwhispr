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
  // Matches the speech gate's speech threshold, which is tuned on real mic input.
  thresholdRms: 0.003,
  // Kept either side of speech so a soft consonant is not clipped off.
  paddingMs: 80,
  // The pause left where a longer silence was cut. Some gap has to survive:
  // splicing words flush together makes a recognizer run them into one.
  maxGapMs: 220,
  // Below this fraction of the original, the plan is assumed wrong and dropped.
  minKeepRatio: 0.2,
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

  const voiced = new Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    const start = w * windowSamples;
    voiced[w] = rms(samples, start, Math.min(total, start + windowSamples)) >= opts.thresholdRms;
  }

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

  const keptSamples = segments.reduce((sum, [start, end]) => sum + (end - start), 0);
  if (keptSamples < total * opts.minKeepRatio) {
    return untouched("kept too little");
  }

  return {
    segments,
    gapSamples: Math.round((opts.maxGapMs / 1000) * sampleRate),
    trimmed: segments.length > 1 || keptSamples < total,
    keptSamples,
    totalSamples: total,
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

module.exports = { planSilenceTrim, applySilenceTrim, SILENCE_TRIM_DEFAULTS: DEFAULTS };
