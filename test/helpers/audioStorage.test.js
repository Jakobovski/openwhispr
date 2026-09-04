const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

test("stored audio can be found and deleted regardless of its truthful extension", (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-audio-storage-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return { app: { getPath: () => userData, isReady: () => false, isPackaged: false } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let AudioStorageManager;
  try {
    delete require.cache[require.resolve("../../src/helpers/audioStorage")];
    AudioStorageManager = require("../../src/helpers/audioStorage");
  } finally {
    Module._load = originalLoad;
  }

  const storage = new AudioStorageManager();
  const saved = storage.saveAudio(42, Buffer.from("RIFF"), "2026-09-03T12:00:00Z", "audio/wav");
  assert.equal(saved.success, true);
  assert.match(saved.path, /-42\.wav$/);
  assert.equal(storage.getAudioPath(42), saved.path);
  assert.deepEqual(storage.getAudioBuffer(42), Buffer.from("RIFF"));
  assert.deepEqual(storage.getAudioFile(42), {
    buffer: Buffer.from("RIFF"),
    filePath: saved.path,
    fileName: path.basename(saved.path),
    mimeType: "audio/wav",
  });

  assert.equal(storage.deleteAudio(42).success, true);
  assert.equal(storage.getAudioPath(42), null);
});
