import { concatFrames, encodeWavPcm16Buffer, UPLOAD_SAMPLE_RATE } from "../utils/pcmAudio";

// Captures dictation as 16 kHz mono PCM straight from the microphone.
//
// MediaRecorder cannot do this: Chromium only gives it Opus, which is lossy, and a lossy
// round trip changed the transcript on two of the three providers in testing. Capturing
// through an AudioWorklet instead means the recogniser sees the microphone's own samples
// at the rate every provider resamples to internally — no encode, no decode, no resample.
//
// Deliberately mirrors the MediaRecorder interface the batch path already depends on —
// `state`, `stop()`, an `onstop` that hands over a finished segment — so mic-death
// rotation, cancel-mid-recording and discarded-recording persistence keep working
// unchanged. The worklet is inlined as a blob URL because the renderer is packaged and
// has no stable URL to load a module file from, the same approach meetingRecordingStore
// uses.
const WORKLET_SOURCE = `
class DictationPcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // A disconnected or silent-by-design input yields no channel; keep the node alive so
    // recording survives a momentary gap rather than ending the graph.
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor("dictation-pcm-processor", DictationPcmProcessor);
`;

let workletBlobUrl = null;
function getWorkletUrl() {
  if (!workletBlobUrl) {
    workletBlobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
  }
  return workletBlobUrl;
}

export class PcmBatchRecorder {
  /**
   * @param {MediaStream} stream microphone stream to capture
   * @param {(frame: Float32Array) => void} [onFrame] called per captured block, for the
   *   "did any audio arrive" check the batch path makes
   */
  constructor(stream, onFrame) {
    this.stream = stream;
    this.onFrame = onFrame;
    this.onstop = null;
    this._frames = [];
    this._state = "inactive";
    this._context = null;
    this._source = null;
    this._processor = null;
  }

  /** "recording" | "inactive", matching what the batch path checks on MediaRecorder. */
  get state() {
    return this._state;
  }

  /** Samples captured so far, at UPLOAD_SAMPLE_RATE. */
  get sampleRate() {
    return this._context?.sampleRate ?? UPLOAD_SAMPLE_RATE;
  }

  async start() {
    if (this._state === "recording") return;
    // Constructed at the target rate so the browser resamples during capture; asking for
    // 16 kHz here is what removes the separate resample step later.
    this._context = new AudioContext({ sampleRate: UPLOAD_SAMPLE_RATE });
    await this._context.audioWorklet.addModule(getWorkletUrl());

    this._source = this._context.createMediaStreamSource(this.stream);
    this._processor = new AudioWorkletNode(this._context, "dictation-pcm-processor");
    this._processor.port.onmessage = (event) => {
      const frame = event.data;
      if (!frame?.length) return;
      this._frames.push(frame);
      this.onFrame?.(frame);
    };

    // Connected to the destination because some Chromium versions do not pull a worklet
    // that has no downstream node. The worklet emits nothing, so this is silent.
    this._source.connect(this._processor);
    this._processor.connect(this._context.destination);
    this._state = "recording";
  }

  /**
   * Ends capture and hands the finished segment to `onstop`, mirroring MediaRecorder's
   * asynchronous stop so callers can keep waiting on the same handshake.
   */
  stop() {
    if (this._state !== "recording") return;
    this._state = "inactive";

    const samples = concatFrames(this._frames);
    this._frames = [];
    const sampleRate = this.sampleRate;

    try {
      this._processor?.port.close();
      this._source?.disconnect();
      this._processor?.disconnect();
    } catch {
      // Teardown races a dying mic; the segment is already captured either way.
    }
    const context = this._context;
    this._context = null;
    context?.close().catch(() => {});

    const blob = new Blob([encodeWavPcm16Buffer(samples, sampleRate)], { type: "audio/wav" });
    // Asynchronous on purpose: MediaRecorder's onstop never ran synchronously inside
    // stop(), and the rotation handshake in replaceBatchMic relies on that ordering.
    Promise.resolve().then(() => this.onstop?.({ blob, samples, sampleRate }));
  }
}

export { UPLOAD_SAMPLE_RATE };
