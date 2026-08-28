const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { WebSocketServer } = require("ws");

// The socket is main-process code, so it pulls in debugLogger, which requires electron.
// Same shim the database tests use — without it the logger throws from inside a timer
// callback (the final-wait warning and the socket error path both log), which surfaces
// as the whole run hanging rather than as a failed assertion.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => "/tmp", isReady: () => false, isPackaged: false } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { LiveTranscriptionSocket } = require("../../src/helpers/liveTranscriptionSocket");
const {
  geminiLiveDialect,
  sonioxRealtimeDialect,
} = require("../../src/helpers/liveTranscriptionDialects");
Module._load = originalLoad;

// Driven against a real local websocket server rather than a mock object, so the things
// that actually broke against the live providers are exercised for real: whether a frame
// went out as binary or text, and whether audio was sent before setup was acknowledged.
// A hand-rolled fake socket would have happily accepted either.

function startServer(onConnection) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      resolve({ wss, port: wss.address().port });
    });
    wss.on("connection", onConnection);
  });
}

/** The real dialect with its URL pointed at the local server. */
function local(dialect, port) {
  return { ...dialect, buildUrl: () => `ws://127.0.0.1:${port}` };
}

const pcm = (bytes = 320) => Buffer.alloc(bytes, 1);
const settle = () => new Promise((r) => setTimeout(r, 60));

test("gemini: no audio is sent before setup is acknowledged", async () => {
  // The real failure: Gemini closes the socket on anything sent before setupComplete.
  const received = { beforeAck: 0, afterAck: 0 };
  let acked = false;

  const { wss, port } = await startServer((ws) => {
    ws.on("message", (data, isBinary) => {
      const text = isBinary ? "" : data.toString();
      if (text.includes('"setup"')) {
        // Deliberately delayed: audio arriving in this window must be held, not dropped
        // and not sent.
        setTimeout(() => {
          acked = true;
          ws.send(JSON.stringify({ setupComplete: {} }));
        }, 80);
        return;
      }
      if (acked) received.afterAck++;
      else received.beforeAck++;
    });
  });

  const socket = new LiveTranscriptionSocket(local(geminiLiveDialect, port));
  await socket.connect({ apiKey: "k", language: "en" });

  // Sent while setup is still outstanding.
  assert.equal(socket.isReady, false, "must not be ready before the ack");
  assert.equal(socket.sendAudio(pcm()), true, "audio must be buffered, not refused");
  assert.equal(socket.sendAudio(pcm()), true);

  await new Promise((r) => setTimeout(r, 200));
  socket.sendAudio(pcm());
  await settle();

  assert.equal(received.beforeAck, 0, "audio reached the server before setupComplete");
  assert.equal(received.afterAck, 3, "buffered audio must be flushed once ready");

  await socket.disconnect(false);
  wss.close();
});

test("gemini: audio goes out as a base64 JSON envelope", async () => {
  let frame = null;
  const { wss, port } = await startServer((ws) => {
    ws.on("message", (data, isBinary) => {
      const text = data.toString();
      if (!isBinary && text.includes('"setup"')) {
        ws.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (!frame) frame = { isBinary, text };
    });
  });

  const socket = new LiveTranscriptionSocket(local(geminiLiveDialect, port));
  await socket.connect({ apiKey: "k" });
  await settle();
  socket.sendAudio(Buffer.from([0, 1, 2, 3]));
  await settle();

  assert.equal(frame.isBinary, false, "gemini audio is JSON, not a raw binary frame");
  const parsed = JSON.parse(frame.text);
  assert.equal(parsed.realtime_input.audio.mime_type, "audio/pcm;rate=16000");
  assert.equal(parsed.realtime_input.audio.data, Buffer.from([0, 1, 2, 3]).toString("base64"));

  await socket.disconnect(false);
  wss.close();
});

test("gemini: partials replace, but finals from separate speech segments accumulate", async (t) => {
  // The bug this exists to catch, reproduced against the live API: Gemini finalises per
  // *speech segment*, so a dictation with a pause in it produces two inputTranscription
  // finals. Treating a final as the whole utterance kept only the last segment, and the
  // user saw a transcript that started mid-sentence.
  const partials = [];
  const { wss, port } = await startServer((ws) => {
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (text.includes('"setup"')) {
        ws.send(JSON.stringify({ setupComplete: {} }));
        // Interims still resend the whole segment, so they must not accumulate.
        ws.send(
          JSON.stringify({ serverContent: { interimInputTranscription: { text: "Download" } } })
        );
        ws.send(
          JSON.stringify({ serverContent: { interimInputTranscription: { text: "Download the" } } })
        );
        // Segment one, ended by the user pausing — mid-recording, long before stop.
        ws.send(
          JSON.stringify({ serverContent: { inputTranscription: { text: "Download the file." } } })
        );
        ws.send(JSON.stringify({ serverContent: { generationComplete: true } }));
        return;
      }
      if (text.includes("audio_stream_end")) {
        // Segment two arrives only after end-of-stream. A socket that took the first
        // generationComplete as the end has already resolved and will never see this.
        ws.send(
          JSON.stringify({ serverContent: { inputTranscription: { text: "Open it for me." } } })
        );
        ws.send(JSON.stringify({ serverContent: { generationComplete: true } }));
      }
    });
  });
  // Registered before the assertions: an assertion that throws must still close the
  // server, or the run hangs on the open handle instead of reporting the failure.
  t.after(() => wss.close());

  const socket = new LiveTranscriptionSocket(local(geminiLiveDialect, port));
  socket.onPartialTranscript = (text) => partials.push(text);
  await socket.connect({ apiKey: "k" });
  await settle();
  const result = await socket.disconnect(true);

  assert.deepEqual(partials, ["Download", "Download the"], "partials must not accumulate");
  assert.equal(result.text, "Download the file. Open it for me.", "both segments, in order");
  assert.equal(result.sawProviderFinal, true);
});

test("gemini: a segment ending mid-recording does not end the stream", async (t) => {
  // The same bug seen from the latency side. Resolving on the first generationComplete
  // made disconnect() return instantly with a truncated transcript — 9ms, which is not a
  // plausible round trip and was the tell in the screenshots.
  let sawAudioAfterFirstSegment = false;
  let firstSegmentSent = false;

  const { wss, port } = await startServer((ws) => {
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (text.includes('"setup"')) {
        ws.send(JSON.stringify({ setupComplete: {} }));
        ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: "First." } } }));
        ws.send(JSON.stringify({ serverContent: { generationComplete: true } }));
        firstSegmentSent = true;
        return;
      }
      if (text.includes("audio_stream_end")) {
        ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: "Second." } } }));
        ws.send(JSON.stringify({ serverContent: { generationComplete: true } }));
        return;
      }
      // Audio still flowing after the provider "completed" a segment: the recording is
      // not over, and the socket must still be feeding it.
      if (firstSegmentSent && text.includes("audio")) sawAudioAfterFirstSegment = true;
    });
  });
  t.after(() => wss.close());

  const socket = new LiveTranscriptionSocket(local(geminiLiveDialect, port));
  await socket.connect({ apiKey: "k" });
  await settle();
  socket.sendAudio(pcm());
  await settle();
  const result = await socket.disconnect(true);

  assert.ok(sawAudioAfterFirstSegment, "the socket kept streaming past the segment boundary");
  assert.ok(result.text.includes("Second."), `the later segment was kept, got: ${result.text}`);
});

test("soniox: end-of-stream is an empty TEXT frame, not binary", async () => {
  // The bug that cost a 408 and an empty transcript: an empty binary frame is silently
  // not recognised as end-of-stream.
  let endFrame = null;
  const { wss, port } = await startServer((ws) => {
    ws.on("message", (data, isBinary) => {
      if (data.length === 0) endFrame = { isBinary };
    });
  });

  const socket = new LiveTranscriptionSocket(local(sonioxRealtimeDialect, port));
  await socket.connect({ apiKey: "k" });
  socket.finalize();
  await settle();

  assert.ok(endFrame, "no empty frame was sent at all");
  assert.equal(endFrame.isBinary, false, "the end-of-stream frame must be text, not binary");

  await socket.disconnect(false);
  wss.close();
});

test("soniox: audio goes out as raw binary with no envelope", async () => {
  let frame = null;
  const { wss, port } = await startServer((ws) => {
    ws.on("message", (data, isBinary) => {
      if (data.length > 0 && !data.toString().includes('"api_key"')) {
        frame = { isBinary, bytes: Buffer.from(data) };
      }
    });
  });

  const socket = new LiveTranscriptionSocket(local(sonioxRealtimeDialect, port));
  await socket.connect({ apiKey: "k" });
  socket.sendAudio(Buffer.from([9, 8, 7]));
  await settle();

  assert.equal(frame.isBinary, true, "soniox audio must be a raw binary frame");
  assert.deepEqual([...frame.bytes], [9, 8, 7], "bytes must go out unwrapped");

  await socket.disconnect(false);
  wss.close();
});

test("soniox: is ready immediately, since its config needs no acknowledgement", async () => {
  const { wss, port } = await startServer(() => {});
  const socket = new LiveTranscriptionSocket(local(sonioxRealtimeDialect, port));
  await socket.connect({ apiKey: "k" });
  assert.equal(socket.isReady, true, "audio may follow the config message directly");
  await socket.disconnect(false);
  wss.close();
});

test("soniox: finals append while the interim tail is replaced", async () => {
  // Both halves arrive in the same frame. Appending the interim would duplicate words as
  // they firm up; assigning the finals would keep only the last fragment.
  const partials = [];
  const { wss, port } = await startServer((ws) => {
    ws.on("message", (data) => {
      if (!data.toString().includes('"api_key"')) return;
      ws.send(
        JSON.stringify({
          tokens: [
            { text: "Let's", is_final: true },
            { text: " sh", is_final: false },
          ],
        })
      );
      ws.send(
        JSON.stringify({
          tokens: [
            { text: " ship", is_final: true },
            { text: " the", is_final: false },
          ],
        })
      );
      ws.send(
        JSON.stringify({
          finished: true,
          tokens: [
            { text: " the build.", is_final: true },
            { text: "<end>", is_final: true },
          ],
        })
      );
    });
  });

  const socket = new LiveTranscriptionSocket(local(sonioxRealtimeDialect, port));
  socket.onPartialTranscript = (text) => partials.push(text);
  await socket.connect({ apiKey: "k" });
  const result = await socket.disconnect(true);

  assert.equal(result.text, "Let's ship the build.", "finals must append in order");
  assert.ok(!result.text.includes("<end>"), "the endpoint marker must never reach the text");
  // The preview shows committed text plus the live tail, so the tail is visible but never
  // double-counted once it commits.
  assert.deepEqual(partials, ["Let's sh", "Let's ship the"]);
  wss.close();
});

test("a provider error surfaces and stops anyone waiting for a transcript", async () => {
  const errors = [];
  const { wss, port } = await startServer((ws) => {
    ws.on("message", (data) => {
      if (!data.toString().includes('"api_key"')) return;
      ws.send(JSON.stringify({ error_code: 408, error_message: "Request timeout." }));
    });
  });

  const socket = new LiveTranscriptionSocket(local(sonioxRealtimeDialect, port));
  socket.onError = (error) => errors.push(error);
  await socket.connect({ apiKey: "k" });
  await settle();

  // Must return rather than hang for the full final-wait window.
  const startedAt = Date.now();
  const result = await socket.disconnect(true);
  assert.ok(Date.now() - startedAt < 2000, "an errored stream must not wait out the timeout");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 408);
  assert.equal(result.text, "");
  wss.close();
});

test("a close before the final still returns the finals already received", async () => {
  // Better to paste what was committed than to lose the dictation because the socket
  // dropped before the closing transcript.
  const { wss, port } = await startServer((ws) => {
    ws.on("message", (data) => {
      if (!data.toString().includes('"api_key"')) return;
      ws.send(JSON.stringify({ tokens: [{ text: "half a sentence", is_final: true }] }));
      setTimeout(() => ws.close(), 40);
    });
  });

  const socket = new LiveTranscriptionSocket(local(sonioxRealtimeDialect, port));
  await socket.connect({ apiKey: "k" });
  await new Promise((r) => setTimeout(r, 120));
  const result = await socket.disconnect(true);

  assert.equal(result.text, "half a sentence");
  assert.equal(result.sawProviderFinal, true);
  wss.close();
});

test("audio beyond the pre-ready buffer is refused rather than silently grown", async () => {
  // Reported as a drop so unexplained silence in a transcript has a trail. Unbounded
  // buffering would instead hold minutes of audio for a socket that never came up.
  const { wss, port } = await startServer((ws) => {
    // Never acknowledges setup, so the socket stays not-ready.
    ws.on("message", () => {});
  });

  const socket = new LiveTranscriptionSocket(local(geminiLiveDialect, port));
  await socket.connect({ apiKey: "k" });
  assert.equal(socket.isReady, false);

  let accepted = 0;
  let refused = 0;
  // 4 seconds of audio against a 3 second buffer.
  for (let i = 0; i < 40; i++) {
    if (socket.sendAudio(pcm(3200))) accepted++;
    else refused++;
  }
  assert.ok(accepted > 0, "some audio must be buffered");
  assert.ok(refused > 0, "the buffer must stop growing");

  await socket.disconnect(false);
  wss.close();
});

test("an empty frame is never treated as audio", async () => {
  const { wss, port } = await startServer(() => {});
  const socket = new LiveTranscriptionSocket(local(sonioxRealtimeDialect, port));
  await socket.connect({ apiKey: "k" });
  assert.equal(socket.sendAudio(Buffer.alloc(0)), false);
  assert.equal(socket.sendAudio(null), false);
  assert.equal(socket.audioBytesSent, 0);
  await socket.disconnect(false);
  wss.close();
});

test("a dialect must be named, so an unconfigured socket fails loudly", () => {
  assert.throws(() => new LiveTranscriptionSocket({}), /named dialect/);
  assert.throws(() => new LiveTranscriptionSocket(null), /named dialect/);
});
