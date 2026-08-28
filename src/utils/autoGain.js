// Decides how much to amplify a quiet recording before it is uploaded.
//
// A mic set too low, or someone sitting back from it, produces audio that is perfectly
// audible to a human but transcribes badly: the recognizer's own front end normalizes
// too, and it does so after quantization, so detail that fell below a few PCM16 steps
// is already gone by then. Raising the level first is cheap and, unlike trimming,
// not destructive.
//
// Boost only, never attenuate. The problem being solved is quiet audio; audio that is
// already loud is fine, and audio that is already clipped cannot be repaired by turning
// it down. Refusing to attenuate also means this can never make a recording that
// transcribes correctly today sound worse tomorrow.
//
// Two levels are measured, not one:
//   - Speech level, as a high percentile of per-window RMS. A whole-signal RMS is
//     dragged down by pauses, and dictation is mostly pauses, so it would ask for far
//     more gain than the speech actually needs.
//   - A robust peak, as a high percentile of per-window peaks, which sets the available
//     headroom. A true maximum would let one keyboard click or door slam decide the
//     gain for the whole recording and pin it at 1.0 — exactly the noisy-desk case
//     this is meant to help.
//
// This module only decides. The gain is applied by folding it into the WAV encoder's
// existing clamp loop, so applying it costs one multiply per sample and no extra pass
// or allocation. There is deliberately no second apply function here: a separate one
// would be a second place for the clamping rule to live and drift.

// On by default: a quiet recording transcribes badly and this is a no-op when the level
// is already healthy. Exposed as a setting because it is a change to the audio the
// provider hears, and someone who suspects it of a problem needs to be able to rule it
// out rather than reason about it.
const DEFAULT_AUTO_GAIN_ENABLED = true;

const DEFAULTS = {
  // Matches the window silenceTrim uses: long enough for RMS to be stable, short
  // enough that one window is either speech or not.
  windowMs: 20,
  // Roughly -20 dBFS. A conventional speech level for ASR front ends: loud enough to
  // use the PCM16 range, quiet enough to leave room for peaks well above the RMS.
  targetRms: 0.1,
  // No sample should exceed this after gain. Headroom below 1.0 so PCM16 rounding in
  // the encoder cannot round a sample up into a clip.
  maxPeak: 0.95,
  // Ceiling on amplification. Past this a recording is mostly noise floor, and
  // boosting it just delivers louder noise — with a recognizer more likely to
  // hallucinate words into the hiss than to find any that were really there.
  maxGain: 8,
  // Below this the recording holds no signal to raise. Prevents dividing the target by
  // near-zero and asking for enormous gain on a dead mic.
  silenceRms: 0.0005,
  // Anything smaller is inaudible and not worth the multiply. Also keeps the common
  // already-loud-enough case a genuine no-op.
  minGain: 1.05,
  // Percentile of window RMS taken as the speech level.
  speechPercentile: 0.9,
  // Percentile of window peaks taken as the peak, ignoring the loudest few windows.
  peakPercentile: 0.99,
  // Ceiling on how many windows are actually examined, spread evenly across the whole
  // recording. This is what keeps the decision constant-time instead of proportional
  // to length: a level estimate needs a representative sample, not every window, and
  // measuring all of them cost 12.8ms on a five-minute recording against 1ms here.
  // 600 windows is 12 seconds of audio, sampled across however long the take is.
  maxWindows: 600,
};

/** Nearest-rank percentile over an already-ascending array. */
function percentileSorted(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

/**
 * How much to amplify, and why.
 *
 * @param {Float32Array|number[]} samples - Mono PCM in [-1, 1]
 * @param {number} sampleRate
 * @param {object} [options] - Overrides for DEFAULTS
 * @returns {{gain: number, applied: boolean, speechRms: number, peak: number,
 *            windowsExamined: number, reason?: string}}
 */
function planAutoGain(samples, sampleRate, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const total = samples?.length || 0;
  const skip = (reason, extra = {}) => ({
    gain: 1,
    applied: false,
    speechRms: 0,
    peak: 0,
    windowsExamined: 0,
    reason,
    ...extra,
  });

  if (!total || !Number.isFinite(sampleRate) || sampleRate <= 0) return skip("no-audio");

  const windowSize = Math.max(1, Math.round((opts.windowMs / 1000) * sampleRate));
  const availableWindows = Math.max(1, Math.ceil(total / windowSize));
  // Stride so the examined windows span the whole recording rather than clustering at
  // the start, which would miss someone who drifts away from the mic partway through.
  const stride = Math.max(1, Math.ceil(availableWindows / opts.maxWindows));
  const examined = Math.ceil(availableWindows / stride);

  const windowRms = new Float64Array(examined);
  const windowPeak = new Float64Array(examined);
  let written = 0;
  for (let w = 0; w < availableWindows && written < examined; w += stride) {
    const start = w * windowSize;
    const end = Math.min(total, start + windowSize);
    let sumSquares = 0;
    let peak = 0;
    for (let i = start; i < end; i++) {
      const sample = samples[i];
      sumSquares += sample * sample;
      const magnitude = sample < 0 ? -sample : sample;
      if (magnitude > peak) peak = magnitude;
    }
    windowRms[written] = Math.sqrt(sumSquares / Math.max(1, end - start));
    windowPeak[written] = peak;
    written += 1;
  }

  const sortedRms = windowRms.subarray(0, written).slice().sort();
  const sortedPeak = windowPeak.subarray(0, written).slice().sort();
  const speechRms = percentileSorted(sortedRms, opts.speechPercentile);
  const peak = percentileSorted(sortedPeak, opts.peakPercentile);

  if (speechRms < opts.silenceRms) {
    return skip("silent", { speechRms, peak, windowsExamined: written });
  }

  // Whichever binds first: the level wanted, or the headroom available.
  const wantedGain = opts.targetRms / speechRms;
  const headroomGain = peak > 0 ? opts.maxPeak / peak : opts.maxGain;
  const gain = Math.min(wantedGain, headroomGain, opts.maxGain);

  if (gain < opts.minGain) {
    return skip(gain <= 1 ? "already-loud-enough" : "change-too-small", {
      speechRms,
      peak,
      windowsExamined: written,
    });
  }

  return { gain, applied: true, speechRms, peak, windowsExamined: written };
}

module.exports = { planAutoGain, AUTO_GAIN_DEFAULTS: DEFAULTS, DEFAULT_AUTO_GAIN_ENABLED };
