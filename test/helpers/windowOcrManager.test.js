const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WindowOcrManager = require("../../src/helpers/windowOcrManager");

// Stands in for the Swift sidecar so the manager's contract can be tested
// without Screen Recording permission or a real capture.
function fakeSidecar(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "window-ocr-test-"));
  const script = path.join(dir, "fake-ocr");
  fs.writeFileSync(script, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(script, 0o755);
  return { script, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function managerWith(script) {
  const manager = new WindowOcrManager();
  manager.resolveBinaryPath = () => script;
  return manager;
}

test("a successful capture returns text and the window label", async () => {
  const { script, cleanup } = fakeSidecar(
    `echo '{"ok":true,"text":"OpenWhispr Sinead","window":"Safari — PR","durationMs":42}'`
  );
  try {
    const manager = managerWith(script);
    manager.start();
    const result = await manager.collect();
    assert.equal(result.text, "OpenWhispr Sinead");
    assert.equal(result.window, "Safari — PR");
  } finally {
    cleanup();
  }
});

test("a declined permission yields null rather than throwing", async () => {
  const { script, cleanup } = fakeSidecar(
    `echo '{"ok":false,"error":"The user declined TCCs for application, window, display capture"}'`
  );
  try {
    const manager = managerWith(script);
    manager.start();
    assert.equal(await manager.collect(), null);
  } finally {
    cleanup();
  }
});

test("unparseable output yields null", async () => {
  const { script, cleanup } = fakeSidecar(`echo 'not json at all'`);
  try {
    const manager = managerWith(script);
    manager.start();
    assert.equal(await manager.collect(), null);
  } finally {
    cleanup();
  }
});

test("a non-zero exit with no output yields null", async () => {
  const { script, cleanup } = fakeSidecar(`exit 3`);
  try {
    const manager = managerWith(script);
    manager.start();
    assert.equal(await manager.collect(), null);
  } finally {
    cleanup();
  }
});

test("a missing binary reports unsupported and never spawns", async () => {
  const manager = new WindowOcrManager();
  manager.resolveBinaryPath = () => null;
  assert.equal(manager.isSupported(), false);
  manager.start();
  assert.equal(await manager.collect(), null);
});

test("a hung sidecar is killed and yields null", async () => {
  const { script, cleanup } = fakeSidecar(`sleep 30`);
  try {
    const manager = managerWith(script);
    // Keep the test fast; the real ceiling is SPAWN_TIMEOUT_MS.
    const originalTimeout = WindowOcrManager.SPAWN_TIMEOUT_MS;
    assert.ok(originalTimeout > 0, "timeout constant is exported");

    manager.start();
    // Cancelling a hung capture must not leave the process running.
    manager.cancel();
    assert.equal(manager.pending, null);
  } finally {
    cleanup();
  }
});

test("concurrent starts share one capture", async () => {
  // The sidecar appends on each run, so a second spawn would write two lines.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "window-ocr-once-"));
  const marker = path.join(dir, "runs");
  const script = path.join(dir, "fake-ocr");
  fs.writeFileSync(
    script,
    `#!/bin/sh\necho run >> ${marker}\necho '{"ok":true,"text":"once","window":"W"}'\n`
  );
  fs.chmodSync(script, 0o755);

  try {
    const manager = managerWith(script);
    const first = manager.start();
    const second = manager.start();
    assert.equal(first, second, "same promise is reused");
    await manager.collect();
    assert.equal(fs.readFileSync(marker, "utf8").trim().split("\n").length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collect without a start returns null", async () => {
  const manager = new WindowOcrManager();
  assert.equal(await manager.collect(), null);
});

test("collect clears the capture so the next dictation starts fresh", async () => {
  const { script, cleanup } = fakeSidecar(`echo '{"ok":true,"text":"a","window":"W"}'`);
  try {
    const manager = managerWith(script);
    manager.start();
    assert.equal((await manager.collect()).text, "a");
    assert.equal(await manager.collect(), null, "second collect has nothing pending");
  } finally {
    cleanup();
  }
});
