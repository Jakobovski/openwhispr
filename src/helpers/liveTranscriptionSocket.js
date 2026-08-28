// One websocket state machine for streaming transcription, parameterised by dialect.
//
// Gemini Live and Soniox realtime differ only in wire details — the URL, the opening
// message, how a PCM frame is framed, how end-of-stream is signalled, and how a server
// message is read. Everything else is the same problem, and it is the part that is easy
// to get subtly wrong: audio arriving before the socket is ready, a final transcript that
// has to be waited for after the last frame, a close that must resolve exactly once.
//
// So the dialects stay tiny and declarative (see geminiLiveDialect / sonioxRealtimeDialect)
// and this file owns the sequencing. Deliberately much smaller than deepgramStreaming.js:
// that one also carries warm connections, token refresh, keepalives and replay, none of
// which these two providers need — both authenticate in their first message and neither
// bills for an idle socket.
//
// Audio in is always 16 kHz mono PCM16, which is what the recorder already produces and
// what both providers accept without a re-encode.

const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const CONNECT_TIMEOUT_MS = 10000;
// How long to wait after end-of-stream for the provider's final transcript. Both emit it
// within ~1s in practice; this is the ceiling before giving up and returning whatever
// finals already arrived, which is better than pasting nothing.
const FINAL_WAIT_MS = 5000;
// Audio can arrive from the renderer before the socket is open or acknowledged. Buffering
// rather than dropping is the difference between losing the first word and not.
const PRE_READY_BUFFER_MAX_BYTES = 3 * 16000 * 2; // 3 seconds

class LiveTranscriptionSocket {
  constructor(dialect) {
    if (!dialect?.name) throw new Error("LiveTranscriptionSocket requires a named dialect");
    this.dialect = dialect;

    this.ws = null;
    this.isConnected = false;
    // Ready means "audio will be accepted": open, plus the setup acknowledgement for a
    // dialect that requires one.
    this.isReady = false;
    this.sessionId = null;
    this.sessionStartedAt = null;

    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;

    this.finalText = "";
    this.lastPartial = "";
    this.audioBytesSent = 0;
    this.currentModel = dialect.defaultModel ?? null;

    this.preReadyBuffer = [];
    this.preReadyBufferBytes = 0;

    this._connectSettled = false;
    this._finalResolve = null;
    this._finalTimer = null;
    this._sawProviderFinal = false;
    // Set once no further transcript can arrive — the provider errored, said it was
    // finished, or the socket closed. Without it a disconnect that happens *after* one of
    // those still waits out the full final-wait window, because _resolveFinal has nobody
    // to resolve at the moment the news arrives. That cost a 5 second stall before the
    // fallback transcript could be pasted.
    this._streamEnded = false;
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      isReady: this.isReady,
      sessionId: this.sessionId,
      provider: this.dialect.name,
      model: this.currentModel,
      audioBytesSent: this.audioBytesSent,
    };
  }

  async connect(options = {}) {
    if (this.ws) await this.disconnect(false);

    this.finalText = "";
    this.lastPartial = "";
    this.audioBytesSent = 0;
    this.preReadyBuffer = [];
    this.preReadyBufferBytes = 0;
    this._connectSettled = false;
    this._sawProviderFinal = false;
    this._streamEnded = false;
    this.sessionId = `${this.dialect.name}-${options.sessionSeed ?? ""}${Date.now()}`;
    this.sessionStartedAt = Date.now();
    this.currentModel = options.model ?? this.dialect.defaultModel ?? null;

    const url = this.dialect.buildUrl(options);

    await new Promise((resolve, reject) => {
      const settle = (fn, arg) => {
        if (this._connectSettled) return;
        this._connectSettled = true;
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(
        () => settle(reject, new Error(`${this.dialect.name} connect timed out`)),
        options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
      );

      let ws;
      try {
        ws = new WebSocket(url, this.dialect.socketOptions?.(options) ?? undefined);
      } catch (error) {
        settle(reject, error);
        return;
      }
      this.ws = ws;

      ws.on("open", () => {
        this.isConnected = true;
        const setup = this.dialect.buildSetup?.(options);
        if (setup) ws.send(typeof setup === "string" ? setup : JSON.stringify(setup));

        // A dialect that acknowledges setup must not be sent audio yet — Gemini closes
        // the socket on anything before setupComplete. One that does not is ready now.
        if (!this.dialect.needsSetupAck) {
          this._markReady();
        }
        settle(resolve);
      });

      ws.on("message", (raw) => this._handleMessage(raw));

      ws.on("error", (error) => {
        debugLogger.error(
          `${this.dialect.name} streaming socket error`,
          { error: error.message },
          "streaming"
        );
        this.onError?.(error);
        settle(reject, error);
      });

      ws.on("close", (code, reason) => {
        const wasConnected = this.isConnected;
        this.isConnected = false;
        this.isReady = false;
        // Resolve any waiter: a close before the final transcript still has to hand back
        // whatever finals arrived, or the dictation silently produces nothing.
        this._resolveFinal();
        if (wasConnected) {
          this.onSessionEnd?.({
            sessionId: this.sessionId,
            code,
            reason: reason?.toString?.() ?? "",
            durationMs: Date.now() - (this.sessionStartedAt ?? Date.now()),
          });
        }
        settle(reject, new Error(`${this.dialect.name} socket closed before ready (${code})`));
      });
    });
  }

  /** Flush anything the renderer sent while the socket was still coming up. */
  _markReady() {
    if (this.isReady) return;
    this.isReady = true;
    const buffered = this.preReadyBuffer;
    this.preReadyBuffer = [];
    this.preReadyBufferBytes = 0;
    for (const chunk of buffered) this._writeAudio(chunk);
  }

  _handleMessage(raw) {
    let parsed;
    try {
      parsed = this.dialect.parseMessage(JSON.parse(raw.toString()));
    } catch {
      // Not JSON, or a shape the dialect does not recognise. Not fatal: both providers
      // send informational frames that carry no transcript.
      return;
    }
    if (!parsed) return;

    // A dialect may return several events for one message, because one message can carry
    // several things: Soniox sends newly finalised tokens and the unfinalised tail in the
    // same frame, and collapsing that to a single event drops the tail from the preview.
    for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
      if (event) this._handleEvent(event);
    }
  }

  _handleEvent(parsed) {
    switch (parsed.kind) {
      case "setup":
        this._markReady();
        return;
      case "partial":
        // Partials replace rather than accumulate for both providers, though for
        // different reasons — Gemini resends the whole utterance, Soniox resends the
        // unfinalised tail. Either way the consumer wants the latest, not a sum.
        this.lastPartial = parsed.text ?? "";
        this.onPartialTranscript?.(this.finalText + this.lastPartial);
        return;
      case "final":
        // Appended, not assigned: Soniox emits newly finalised fragments, so assigning
        // would keep only the last one. Gemini emits the whole utterance once, where
        // appending to an empty accumulator is the same thing.
        if (parsed.replaces) this.finalText = parsed.text ?? "";
        else this.finalText += parsed.text ?? "";
        this.lastPartial = "";
        this._sawProviderFinal = true;
        this.onFinalTranscript?.(this.finalText);
        return;
      case "finished":
        if (parsed.text) {
          if (parsed.replaces) this.finalText = parsed.text;
          else this.finalText += parsed.text;
        }
        this._sawProviderFinal = true;
        this._resolveFinal();
        return;
      case "error": {
        const error = new Error(parsed.error?.message ?? `${this.dialect.name} stream error`);
        error.code = parsed.error?.code;
        this.onError?.(error);
        // An error means no transcript is coming; stop anyone waiting for one.
        this._resolveFinal();
        return;
      }
      default:
        return;
    }
  }

  _writeAudio(buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const framed = this.dialect.encodeAudio(buffer);
    this.ws.send(typeof framed === "string" ? framed : framed);
    this.audioBytesSent += buffer.length;
    return true;
  }

  /**
   * One PCM16 frame from the renderer.
   *
   * Returns false only when the frame was neither sent nor buffered, which the caller
   * logs as a drop — silence in the transcript is otherwise unexplainable.
   */
  sendAudio(buffer) {
    if (!buffer?.length) return false;

    if (!this.isReady) {
      if (this.preReadyBufferBytes + buffer.length > PRE_READY_BUFFER_MAX_BYTES) return false;
      this.preReadyBuffer.push(buffer);
      this.preReadyBufferBytes += buffer.length;
      return true;
    }
    return this._writeAudio(buffer);
  }

  /** Tell the provider the utterance is over so it emits its final transcript. */
  finalize() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    // Anything still buffered is real speech and has to go before the end marker.
    this._markReady();
    const signal = this.dialect.buildEndOfStream?.();
    if (signal === null || signal === undefined) return false;
    this.ws.send(signal);
    return true;
  }

  _resolveFinal() {
    this._streamEnded = true;
    if (!this._finalResolve) return;
    const resolve = this._finalResolve;
    this._finalResolve = null;
    clearTimeout(this._finalTimer);
    this._finalTimer = null;
    resolve({ text: this.finalText, sawProviderFinal: this._sawProviderFinal });
  }

  /**
   * @param {boolean} waitForFinal - Send end-of-stream and wait for the provider's final
   *   transcript before closing. False tears down immediately, for a cancelled dictation.
   */
  async disconnect(waitForFinal = true) {
    const ws = this.ws;
    if (!ws) return { text: this.finalText, sawProviderFinal: this._sawProviderFinal };

    if (!waitForFinal) {
      this.ws = null;
      this.isConnected = false;
      this.isReady = false;
      try {
        ws.close();
      } catch {}
      return { text: this.finalText, sawProviderFinal: this._sawProviderFinal };
    }

    // Already over: the provider errored, finished, or the socket closed. Waiting would
    // add the whole final-wait window to a dictation whose answer is already known.
    if (this._streamEnded) {
      this.ws = null;
      this.isConnected = false;
      this.isReady = false;
      try {
        ws.close();
      } catch {}
      return { text: this.finalText, sawProviderFinal: this._sawProviderFinal };
    }

    const settled = new Promise((resolve) => {
      this._finalResolve = resolve;
      this._finalTimer = setTimeout(() => {
        debugLogger.warn(
          `${this.dialect.name} final transcript did not arrive in time`,
          { waitedMs: FINAL_WAIT_MS, haveText: !!this.finalText },
          "streaming"
        );
        this._resolveFinal();
      }, FINAL_WAIT_MS);
    });

    this.finalize();
    const result = await settled;

    this.ws = null;
    this.isConnected = false;
    this.isReady = false;
    try {
      ws.close();
    } catch {}
    return result;
  }
}

module.exports = { LiveTranscriptionSocket, FINAL_WAIT_MS, PRE_READY_BUFFER_MAX_BYTES };
