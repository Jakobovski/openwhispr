import { concatFrames, encodeWavPcm16Buffer, UPLOAD_SAMPLE_RATE } from "../utils/pcmAudio.js";

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
  constructor() {
    super();
    // Messages on a MessagePort are ordered. Echoing this marker lets the renderer wait
    // until every frame posted before it has arrived before it builds the final WAV.
    this.port.onmessage = (event) => {
      if (event.data === "flush") this.port.postMessage("flushed");
    };
  }

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
    this._generation = 0;
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
    const generation = ++this._generation;
    // Synchronous, like MediaRecorder.start(). A stop arriving while addModule is in
    // flight must see a live recorder and cancel this start instead of finalizing an
    // empty recording while the worklet later comes alive on an orphaned microphone.
    this._state = "recording";
    // Constructed at the target rate so the browser resamples during capture; asking for
    // 16 kHz here is what removes the separate resample step later.
    const context = new AudioContext({ sampleRate: UPLOAD_SAMPLE_RATE });
    this._context = context;
    try {
      if (context.state === "suspended") await context.resume();
      await context.audioWorklet.addModule(getWorkletUrl());
    } catch (error) {
      // stop() deliberately closes the context while startup may still be awaiting it.
      // That cancellation is not a recording error and must not surface as one.
      if (generation !== this._generation || this._state !== "recording") return;
      this._state = "inactive";
      if (this._context === context) this._context = null;
      context.close().catch(() => {});
      throw error;
    }
    if (
      generation !== this._generation ||
      this._state !== "recording" ||
      this._context !== context
    ) {
      return;
    }

    this._source = context.createMediaStreamSource(this.stream);
    this._processor = new AudioWorkletNode(context, "dictation-pcm-processor");
    this._processor.port.onmessage = (event) => {
      const frame = event.data;
      if (frame === "flushed") {
        this._flushResolve?.();
        this._flushResolve = null;
        return;
      }
      if (!frame?.length) return;
      this._frames.push(frame);
      this.onFrame?.(frame);
    };

    // Connected to the destination because some Chromium versions do not pull a worklet
    // that has no downstream node. The worklet emits nothing, so this is silent.
    this._source.connect(this._processor);
    this._processor.connect(context.destination);
  }

  /**
   * Ends capture and hands the finished segment to `onstop`, mirroring MediaRecorder's
   * asynchronous stop so callers can keep waiting on the same handshake.
   */
  stop() {
    if (this._state !== "recording") return;
    this._state = "inactive";
    this._generation += 1;
    const context = this._context;
    const sampleRate = context?.sampleRate ?? UPLOAD_SAMPLE_RATE;
    const processor = this._processor;
    try {
      this._source?.disconnect();
    } catch {
      // Teardown races a dying mic; the segment is already captured either way.
    }

    void (async () => {
      // Do not close the port until it has delivered the tail already produced by the
      // audio thread. Without this, releasing the hotkey can drop the final block(s),
      // exactly where the last phoneme of the last word lives.
      if (processor) {
        await new Promise((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, 100);
          this._flushResolve = done;
          try {
            processor.port.postMessage("flush");
          } catch {
            done();
          }
        });
      }

      const samples = concatFrames(this._frames);
      this._frames = [];
      try {
        processor?.port.close();
        processor?.disconnect();
      } catch {}
      if (this._context === context) this._context = null;
      this._source = null;
      this._processor = null;
      context?.close().catch(() => {});

      const blob = new Blob([encodeWavPcm16Buffer(samples, sampleRate)], {
        type: "audio/wav",
      });
      this.onstop?.({ blob, samples, sampleRate });
    })();
  }
}

export { UPLOAD_SAMPLE_RATE };
