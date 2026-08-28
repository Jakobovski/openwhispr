// PCM helpers shared by the capture path and the upload path.
//
// Dictation is captured as raw 16 kHz mono PCM rather than through MediaRecorder, which
// in Chromium can only emit Opus. Opus is lossy, and a lossy round trip changed the
// transcript on two of the three providers in testing — so the samples the recogniser
// sees are now exactly the samples the microphone produced, at the rate every provider
// resamples to internally.
//
// Kept free of browser APIs so the arithmetic is unit-testable: an off-by-one in the
// concatenation or the WAV header corrupts every recording, and that is not something to
// discover by listening.

/** Rate every provider resamples to internally; capturing at it avoids a resample. */
const UPLOAD_SAMPLE_RATE = 16000;

/**
 * Joins captured frames into one buffer.
 *
 * The worklet delivers fixed-size blocks (128 frames by default), so a dictation is
 * thousands of small arrays. Summing the length first means one allocation rather than
 * one per block.
 *
 * @param {Float32Array[]} frames
 * @returns {Float32Array}
 */
function concatFrames(frames) {
  const usable = (frames || []).filter((frame) => frame && frame.length > 0);
  if (usable.length === 0) return new Float32Array(0);
  if (usable.length === 1) return usable[0];

  let total = 0;
  for (const frame of usable) total += frame.length;
  const joined = new Float32Array(total);
  let offset = 0;
  for (const frame of usable) {
    joined.set(frame, offset);
    offset += frame.length;
  }
  return joined;
}

/**
 * 16-bit PCM WAV bytes for the given mono samples.
 *
 * Values outside [-1, 1] are clamped before scaling: a sample that overflows wraps to the
 * opposite sign in 16-bit, which is heard as a click and read by a recogniser as noise.
 *
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
/**
 * Float samples in [-1, 1] to PCM16, which is what every streaming socket here accepts.
 *
 * The asymmetric scale is deliberate and not a rounding quirk: PCM16 runs -32768..32767,
 * so the negative side has one more step than the positive one. Scaling both by 0x7fff
 * wastes that step; scaling both by 0x8000 clips the loudest positive sample to -32768
 * and inverts it.
 */
function floatToPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = samples[i] > 1 ? 1 : samples[i] < -1 ? -1 : samples[i];
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

function encodeWavPcm16Buffer(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/**
 * Seconds of audio in a sample buffer. Guards a zero rate so a misconfigured context
 * reports 0 rather than Infinity, which would render as a nonsense duration.
 */
function samplesToSeconds(sampleCount, sampleRate) {
  if (!sampleRate || sampleRate <= 0) return 0;
  return sampleCount / sampleRate;
}

module.exports = {
  UPLOAD_SAMPLE_RATE,
  concatFrames,
  encodeWavPcm16Buffer,
  floatToPcm16,
  samplesToSeconds,
};
