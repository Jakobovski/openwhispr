const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");

const XaiStreaming = require("../../src/helpers/xaiStreaming");

// Spins up a local ws server and hands `run` its URL plus the live socket.
// `onConnection` decides whether/when the server sends transcript.created.
async function withServer(onConnection, run) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));

  const received = { binary: [], json: [] };
  let socket = null;
  server.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        received.binary.push(Buffer.from(data));
      } else {
        try {
          received.json.push(JSON.parse(data.toString()));
        } catch {
          // ignore
        }
      }
    });
    onConnection?.(ws);
  });

  try {
    await run({
      url: `ws://127.0.0.1:${server.address().port}`,
      received,
      getSocket: () => socket,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const ready = (ws) => ws.send(JSON.stringify({ type: "transcript.created", request_id: "sess-1" }));

async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for: ${message}`);
}

function connected(url) {
  const streaming = new XaiStreaming();
  streaming.buildWebSocketUrl = () => url;
  return streaming;
}

test("connect resolves once the server sends transcript.created", async () => {
  await withServer(ready, async ({ url }) => {
    const streaming = connected(url);
    try {
      await streaming.connect({ apiKey: "test-key" });
      assert.equal(streaming.isConnected, true);
      assert.equal(streaming.serverReady, true);
      assert.equal(streaming.sessionId, "sess-1");
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("connect rejects when the socket closes before transcript.created", async () => {
  await withServer(
    (ws) => ws.close(1008, "rejected"),
    async ({ url }) => {
      const streaming = connected(url);
      try {
        await assert.rejects(() => streaming.connect({ apiKey: "test-key" }), /closed.*1008/i);
      } finally {
        streaming.cleanupAll();
      }
    }
  );
});

test("connect rejects without an API key", async () => {
  const streaming = new XaiStreaming();
  await assert.rejects(() => streaming.connect({}), /requires an API key/i);
});

test("warmup resolves on transcript.created and can be promoted by connect", async () => {
  await withServer(ready, async ({ url }) => {
    const streaming = connected(url);
    try {
      await streaming.warmup({ apiKey: "test-key" });
      assert.equal(streaming.hasWarmConnection(), true);
      assert.equal(streaming.warmSessionId, "sess-1");

      // Promoting the warm socket must not re-run the handshake.
      await streaming.connect({ apiKey: "test-key" });
      assert.equal(streaming.isConnected, true);
      assert.equal(streaming.serverReady, true);
      assert.equal(streaming.hasWarmConnection(), false);
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("warmup rejects when the socket closes before transcript.created", async () => {
  await withServer(
    (ws) => ws.close(1008, "rejected"),
    async ({ url }) => {
      const streaming = connected(url);
      try {
        await assert.rejects(() => streaming.warmup({ apiKey: "test-key" }), /closed.*1008/i);
      } finally {
        streaming.cleanupAll();
      }
    }
  );
});

test("chunk finals feed the preview; only utterance finals commit a segment", async () => {
  await withServer(ready, async ({ url, getSocket }) => {
    const streaming = connected(url);
    const partials = [];
    const finals = [];
    streaming.onPartialTranscript = (text) => partials.push(text);
    streaming.onFinalTranscript = (text) => finals.push(text);

    try {
      await streaming.connect({ apiKey: "test-key" });
      const ws = getSocket();

      // Interim — text may still change.
      ws.send(JSON.stringify({ type: "transcript.partial", text: "hello", is_final: false }));
      // Chunk final — locked, but the utterance final restates it.
      ws.send(
        JSON.stringify({
          type: "transcript.partial",
          text: "hello there",
          is_final: true,
          speech_final: false,
        })
      );
      await waitFor(() => partials.length === 2, "two preview updates");
      assert.deepEqual(partials, ["hello", "hello there"]);
      assert.deepEqual(streaming.completedSegments, []);
      assert.equal(streaming.accumulatedText, "");

      // Utterance final — the complete stitched utterance.
      ws.send(
        JSON.stringify({
          type: "transcript.partial",
          text: "Hello there, friend.",
          is_final: true,
          speech_final: true,
          start: 0,
        })
      );
      await waitFor(() => finals.length === 1, "one committed segment");
      assert.deepEqual(streaming.completedSegments, ["Hello there, friend."]);
      assert.equal(streaming.accumulatedText, "Hello there, friend.");

      // A second utterance appends rather than replacing.
      ws.send(
        JSON.stringify({
          type: "transcript.partial",
          text: "How are you?",
          is_final: true,
          speech_final: true,
        })
      );
      await waitFor(() => finals.length === 2, "two committed segments");
      assert.equal(streaming.accumulatedText, "Hello there, friend. How are you?");
      assert.equal(partials.length, 2, "utterance finals must not reach the preview");
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("transcript.done is adopted only when no utterance final was seen", async () => {
  await withServer(ready, async ({ url, getSocket }) => {
    const streaming = connected(url);
    try {
      await streaming.connect({ apiKey: "test-key" });
      getSocket().send(
        JSON.stringify({ type: "transcript.done", text: "salvaged tail", duration: 1.2 })
      );
      await waitFor(() => streaming.accumulatedText !== "", "salvaged text");
      assert.equal(streaming.accumulatedText, "salvaged tail");
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("transcript.done does not duplicate text already committed", async () => {
  await withServer(ready, async ({ url, getSocket }) => {
    const streaming = connected(url);
    try {
      await streaming.connect({ apiKey: "test-key" });
      const ws = getSocket();
      ws.send(
        JSON.stringify({
          type: "transcript.partial",
          text: "one two",
          is_final: true,
          speech_final: true,
        })
      );
      await waitFor(() => streaming.accumulatedText === "one two", "committed utterance");

      ws.send(JSON.stringify({ type: "transcript.done", text: "one two" }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(streaming.accumulatedText, "one two");
      assert.deepEqual(streaming.completedSegments, ["one two"]);
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("audio sent before transcript.created is buffered, then flushed in order", async () => {
  let release = null;
  await withServer(
    (ws) => {
      release = () => ready(ws);
    },
    async ({ url, received }) => {
      const streaming = connected(url);
      try {
        const pending = streaming.connect({ apiKey: "test-key" });
        await waitFor(() => streaming.ws?.readyState === 1, "socket open");

        assert.equal(streaming.sendAudio(Buffer.from([1, 2])), true);
        assert.equal(streaming.sendAudio(Buffer.from([3, 4])), true);
        assert.equal(received.binary.length, 0, "nothing may reach xAI before it is ready");

        release();
        await pending;
        await waitFor(() => received.binary.length === 2, "buffered frames flushed");
        assert.deepEqual(Buffer.concat(received.binary), Buffer.from([1, 2, 3, 4]));
        assert.equal(streaming.audioBytesSent, 4);
      } finally {
        streaming.cleanupAll();
      }
    }
  );
});

test("the pre-ready buffer is capped rather than growing without bound", async () => {
  await withServer(
    () => {},
    async ({ url }) => {
      const streaming = connected(url);
      try {
        streaming.connect({ apiKey: "test-key" }).catch(() => {});
        await waitFor(() => streaming.ws?.readyState === 1, "socket open");

        const chunk = Buffer.alloc(64 * 1024);
        for (let i = 0; i < 40; i++) streaming.sendAudio(chunk);
        // 3s of 16kHz 16-bit mono, plus at most one chunk of overshoot.
        assert.ok(
          streaming.preReadyBufferSize <= 3 * 16000 * 2 + chunk.length,
          `buffer grew to ${streaming.preReadyBufferSize}`
        );
      } finally {
        streaming.cleanupAll();
      }
    }
  );
});

test("finalize forces the current utterance to close", async () => {
  await withServer(ready, async ({ url, received }) => {
    const streaming = connected(url);
    try {
      await streaming.connect({ apiKey: "test-key" });
      assert.equal(streaming.finalize(), true);
      await waitFor(() => received.json.length === 1, "Finalize message");
      assert.deepEqual(received.json[0], { type: "Finalize" });
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("disconnect finalizes, signals audio.done, and returns the accumulated text", async () => {
  await withServer(
    (ws) => {
      ready(ws);
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message.type === "audio.done") {
          ws.send(JSON.stringify({ type: "transcript.done", text: "all done" }));
        }
      });
    },
    async ({ url, received }) => {
      const streaming = connected(url);
      try {
        await streaming.connect({ apiKey: "test-key" });
        getSocketText(streaming, "hi there");

        const result = await streaming.disconnect(true);
        assert.equal(result.text, "hi there");
        assert.deepEqual(
          received.json.map((m) => m.type),
          ["Finalize", "audio.done"]
        );
      } finally {
        streaming.cleanupAll();
      }
    }
  );
});

// Commits a segment the way the server would, without racing the socket.
function getSocketText(streaming, text) {
  streaming.handleMessage(
    Buffer.from(
      JSON.stringify({
        type: "transcript.partial",
        text,
        is_final: true,
        speech_final: true,
      })
    )
  );
}

test("buildWebSocketUrl asks for PCM interim results at the capture rate", () => {
  const params = new URL(
    new XaiStreaming().buildWebSocketUrl({ sampleRate: 24000, language: "en" })
  ).searchParams;
  assert.equal(params.get("encoding"), "pcm");
  assert.equal(params.get("sample_rate"), "24000");
  assert.equal(params.get("interim_results"), "true");
  assert.equal(params.get("language"), "en");
});

test("buildWebSocketUrl omits languages xAI does not support", () => {
  const url = (language) => new URL(new XaiStreaming().buildWebSocketUrl({ language }));

  // Supported, and regional variants fall back to the base code.
  assert.equal(url("pt-BR").searchParams.get("language"), "pt");
  // Unsupported and "auto" both mean server-side detection.
  assert.equal(url("cy").searchParams.get("language"), null);
  assert.equal(url("auto").searchParams.get("language"), null);
  assert.equal(url(undefined).searchParams.get("language"), null);
});

test("buildWebSocketUrl enforces xAI's keyterm limits", () => {
  const keyterms = [
    "  OpenWhispr  ",
    "",
    "x".repeat(80),
    ...Array.from({ length: 120 }, (_, i) => `term-${i}`),
  ];
  const params = new URL(new XaiStreaming().buildWebSocketUrl({ keyterms })).searchParams;
  const terms = params.getAll("keyterm");

  assert.equal(terms.length, 99, "100 candidates minus the empty one");
  assert.equal(terms[0], "OpenWhispr");
  assert.equal(terms[1].length, 50);
});

test("smart turn options are only sent when a caller opts in", () => {
  const defaults = new URL(new XaiStreaming().buildWebSocketUrl({})).searchParams;
  assert.equal(defaults.get("smart_turn"), null);
  assert.equal(defaults.get("endpointing"), null);
  assert.equal(defaults.get("vad_threshold"), null);

  const tuned = new URL(
    new XaiStreaming().buildWebSocketUrl({
      smartTurn: 0.7,
      smartTurnTimeout: 3000,
      endpointing: 300,
      vadThreshold: 0.2,
    })
  ).searchParams;
  assert.equal(tuned.get("smart_turn"), "0.7");
  assert.equal(tuned.get("smart_turn_timeout"), "3000");
  assert.equal(tuned.get("endpointing"), "300");
  assert.equal(tuned.get("vad_threshold"), "0.2");
});
