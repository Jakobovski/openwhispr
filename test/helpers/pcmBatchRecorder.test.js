const test = require("node:test");
const assert = require("node:assert/strict");

let addModuleImpl = async () => {};
let nodeFactory = null;
let contexts = [];
let initialContextState = "running";

class FakeAudioContext {
  constructor() {
    this.sampleRate = 16000;
    this.state = initialContextState;
    this.destination = {};
    this.closed = false;
    this.resumeCalls = 0;
    this.audioWorklet = { addModule: (...args) => addModuleImpl(...args) };
    contexts.push(this);
  }

  async resume() {
    this.resumeCalls += 1;
    this.state = "running";
  }

  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }

  async close() {
    this.closed = true;
    this.state = "closed";
  }
}

class FakeAudioWorkletNode {
  constructor() {
    if (nodeFactory) return nodeFactory();
    this.port = { onmessage: null, postMessage() {}, close() {} };
  }
  connect() {}
  disconnect() {}
}

global.AudioContext = FakeAudioContext;
global.AudioWorkletNode = FakeAudioWorkletNode;

const { PcmBatchRecorder } = require("../../src/helpers/pcmBatchRecorder");

function fakeStream() {
  return { getTracks: () => [] };
}

test.beforeEach(() => {
  addModuleImpl = async () => {};
  nodeFactory = null;
  contexts = [];
  initialContextState = "running";
});

test("stop during worklet startup cannot leave an orphaned recorder", async () => {
  let release;
  addModuleImpl = () => new Promise((resolve) => (release = resolve));
  let nodesCreated = 0;
  nodeFactory = () => {
    nodesCreated += 1;
    return {
      port: { onmessage: null, postMessage() {}, close() {} },
      connect() {},
      disconnect() {},
    };
  };

  const recorder = new PcmBatchRecorder(fakeStream());
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  const starting = recorder.start();
  assert.equal(recorder.state, "recording", "start must become stoppable synchronously");

  recorder.stop();
  await stopped;
  release();
  await starting;

  assert.equal(recorder.state, "inactive");
  assert.equal(nodesCreated, 0, "the cancelled start must not connect a worklet later");
  assert.equal(contexts[0].closed, true);
});

test("stop flushes queued tail audio before constructing the WAV", async () => {
  nodeFactory = () => {
    const node = {
      port: {
        onmessage: null,
        postMessage(message) {
          if (message !== "flush") return;
          this.onmessage?.({ data: Float32Array.from([0.25, -0.25]) });
          this.onmessage?.({ data: "flushed" });
        },
        close() {},
      },
      connect() {},
      disconnect() {},
    };
    return node;
  };

  const recorder = new PcmBatchRecorder(fakeStream());
  await recorder.start();
  const result = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.stop();
  const stopped = await result;

  assert.deepEqual([...stopped.samples], [0.25, -0.25]);
  assert.equal(stopped.blob.size, 48, "44-byte WAV header plus two PCM16 samples");
});

test("a suspended capture context is resumed before recording", async () => {
  initialContextState = "suspended";
  const recorder = new PcmBatchRecorder(fakeStream());
  await recorder.start();
  assert.equal(contexts[0].resumeCalls, 1);
  recorder.stop();
  await new Promise((resolve) => setImmediate(resolve));
});
