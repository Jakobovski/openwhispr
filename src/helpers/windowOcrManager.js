const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

const BINARY_NAME = "macos-window-ocr";
// Ceiling on how long the transcript will wait for screen context. The sidecar
// has its own (shorter) watchdog; this is the backstop if it wedges entirely.
const SPAWN_TIMEOUT_MS = 6000;
const SIDECAR_TIMEOUT_SECONDS = 4;

// Captures the focused window and OCRs it, in parallel with recording. Every
// failure is non-fatal: screen context is an enhancement, so a denied
// permission, a missing binary or an unsupported OS just yields no terms and
// the transcript is used exactly as transcribed.
class WindowOcrManager {
  constructor() {
    this.cachedBinaryPath = undefined;
    this.pending = null;
    this.child = null;
  }

  resolveBinaryPath() {
    if (this.cachedBinaryPath !== undefined) return this.cachedBinaryPath;

    const candidates = [];
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, "bin", BINARY_NAME));
    }
    candidates.push(path.join(__dirname, "..", "..", "resources", "bin", BINARY_NAME));

    this.cachedBinaryPath = candidates.find((candidate) => fs.existsSync(candidate)) || null;
    if (!this.cachedBinaryPath) {
      debugLogger.debug("Window OCR binary not found", { candidates }, "window-ocr");
    }
    return this.cachedBinaryPath;
  }

  isSupported() {
    return process.platform === "darwin" && !!this.resolveBinaryPath();
  }

  /**
   * Kick off a capture. Call as early as possible — ideally the moment
   * recording starts — so recognition overlaps with the user speaking.
   * Safe to call repeatedly; a capture already in flight is reused.
   */
  start() {
    if (this.pending) {
      debugLogger.debug("Window OCR already in flight, reusing", {}, "window-ocr");
      return this.pending;
    }
    this.pending = this._run().catch((error) => {
      debugLogger.debug("Window OCR failed", { error: error.message }, "window-ocr");
      return null;
    });
    return this.pending;
  }

  /**
   * Await the in-flight capture, if any. Returns null when OCR is unavailable,
   * failed, or was never started — callers must treat null as "no context".
   */
  async collect() {
    if (!this.pending) return null;
    const result = await this.pending;
    this.pending = null;
    return result;
  }

  // Discard an in-flight capture whose transcript will never arrive (a
  // cancelled dictation), so the next one starts clean.
  cancel() {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        // Already gone
      }
    }
    this.child = null;
    this.pending = null;
  }

  _run() {
    const binaryPath = this.resolveBinaryPath();
    if (!binaryPath) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child = null;
        resolve(value);
      };

      let child;
      try {
        child = spawn(binaryPath, [
          "--timeout",
          String(SIDECAR_TIMEOUT_SECONDS),
          "--exclude-pid",
          String(process.pid),
        ]);
      } catch (error) {
        debugLogger.debug("Window OCR spawn threw", { error: error.message }, "window-ocr");
        return resolve(null);
      }
      this.child = child;

      const timer = setTimeout(() => {
        debugLogger.debug("Window OCR timed out, killing", {}, "window-ocr");
        try {
          child.kill();
        } catch {
          // Already gone
        }
        finish(null);
      }, SPAWN_TIMEOUT_MS);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        debugLogger.debug("Window OCR process error", { error: error.message }, "window-ocr");
        finish(null);
      });

      child.on("close", () => {
        let payload;
        try {
          payload = JSON.parse(stdout.trim());
        } catch {
          debugLogger.debug(
            "Window OCR returned unparseable output",
            { stdout: stdout.slice(0, 200), stderr: stderr.slice(0, 200) },
            "window-ocr"
          );
          return finish(null);
        }

        if (!payload?.ok) {
          // A declined permission lands here on every dictation; keep it at
          // debug so it can't spam the log.
          debugLogger.debug("Window OCR unavailable", { error: payload?.error }, "window-ocr");
          return finish(null);
        }

        const text = typeof payload.text === "string" ? payload.text : "";
        debugLogger.debug(
          "Window OCR captured",
          {
            window: payload.window,
            chars: text.length,
            sidecarMs: payload.durationMs,
            totalMs: Date.now() - started,
          },
          "window-ocr"
        );
        finish({ text, window: payload.window || "" });
      });
    });
  }
}

module.exports = WindowOcrManager;
module.exports.SPAWN_TIMEOUT_MS = SPAWN_TIMEOUT_MS;
