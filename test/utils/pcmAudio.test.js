const test = require("node:test");
const assert = require("node:assert/strict");

const {
  UPLOAD_SAMPLE_RATE,
  concatFrames,
  encodeWavPcm16Buffer,
  samplesToSeconds,
} = require("../../src/utils/pcmAudio.js");

const readString = (view, offset, length) =>
  Array.from({ length }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join("");

test("frames join in order with nothing lost", () => {
  const joined = concatFrames([
    new Float32Array([0.1, 0.2]),
    new Float32Array([0.3]),
    new Float32Array([0.4, 0.5, 0.6]),
  ]);

  assert.equal(joined.length, 6);
  assert.deepEqual(
    Array.from(joined).map((v) => +v.toFixed(1)),
    [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
  );
});

test("empty and zero-length frames are skipped, not counted", () => {
  // The worklet can deliver an empty block when a mic drops mid-recording; counting it
  // would shift every later sample and desynchronise the whole recording.
  const joined = concatFrames([
    new Float32Array([1]),
    new Float32Array(0),
    null,
    undefined,
    new Float32Array([-1]),
  ]);

  assert.deepEqual(Array.from(joined), [1, -1]);
  assert.equal(concatFrames([]).length, 0);
  assert.equal(concatFrames(null).length, 0);
});

test("a single frame is passed through without copying", () => {
  const only = new Float32Array([0.25, 0.5]);
  assert.equal(concatFrames([only]), only);
});

test("the WAV header describes 16-bit mono PCM at the given rate", () => {
  const wav = encodeWavPcm16Buffer(new Float32Array(8), UPLOAD_SAMPLE_RATE);
  const view = new DataView(wav);

  assert.equal(readString(view, 0, 4), "RIFF");
  assert.equal(readString(view, 8, 4), "WAVE");
  assert.equal(readString(view, 12, 4), "fmt ");
  assert.equal(view.getUint16(20, true), 1, "format 1 is PCM");
  assert.equal(view.getUint16(22, true), 1, "one channel");
  assert.equal(view.getUint32(24, true), UPLOAD_SAMPLE_RATE);
  assert.equal(view.getUint32(28, true), UPLOAD_SAMPLE_RATE * 2, "byte rate = rate x 2 bytes");
  assert.equal(view.getUint16(32, true), 2, "block align");
  assert.equal(view.getUint16(34, true), 16, "bits per sample");
  assert.equal(readString(view, 36, 4), "data");
});

test("the declared sizes match the bytes actually written", () => {
  // A header that disagrees with the payload is the classic way a WAV plays as static or
  // gets rejected outright by an API.
  const samples = new Float32Array(1000);
  const wav = encodeWavPcm16Buffer(samples, UPLOAD_SAMPLE_RATE);
  const view = new DataView(wav);

  assert.equal(wav.byteLength, 44 + samples.length * 2);
  assert.equal(view.getUint32(4, true), 36 + samples.length * 2, "RIFF size");
  assert.equal(view.getUint32(40, true), samples.length * 2, "data size");
});

test("samples are scaled to full 16-bit range", () => {
  const wav = encodeWavPcm16Buffer(new Float32Array([0, 1, -1, 0.5]), UPLOAD_SAMPLE_RATE);
  const view = new DataView(wav);

  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 32767, "+1 maps to the positive maximum");
  assert.equal(view.getInt16(48, true), -32768, "-1 maps to the negative minimum");
  assert.equal(view.getInt16(50, true), 16383);
});

test("overshooting samples clamp instead of wrapping", () => {
  // Without the clamp, 1.5 wraps to a large negative value: an audible click, and noise
  // to a recogniser.
  const wav = encodeWavPcm16Buffer(new Float32Array([1.5, -1.5]), UPLOAD_SAMPLE_RATE);
  const view = new DataView(wav);

  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
});

test("an empty recording still produces a valid, empty WAV", () => {
  const wav = encodeWavPcm16Buffer(new Float32Array(0), UPLOAD_SAMPLE_RATE);
  const view = new DataView(wav);

  assert.equal(wav.byteLength, 44);
  assert.equal(view.getUint32(40, true), 0);
});

test("duration is derived from the sample count, and a bad rate reports zero", () => {
  assert.equal(samplesToSeconds(UPLOAD_SAMPLE_RATE * 3, UPLOAD_SAMPLE_RATE), 3);
  assert.equal(samplesToSeconds(8000, UPLOAD_SAMPLE_RATE), 0.5);
  assert.equal(samplesToSeconds(1000, 0), 0);
});

test("16 kHz mono PCM is 32 KB per second", () => {
  // The point of the change: 48 kHz was 96 KB/s, and this is the figure the upload logs
  // should now show.
  const oneSecond = encodeWavPcm16Buffer(new Float32Array(UPLOAD_SAMPLE_RATE), UPLOAD_SAMPLE_RATE);
  assert.equal(Math.round((oneSecond.byteLength - 44) / 1024), 31);
});
