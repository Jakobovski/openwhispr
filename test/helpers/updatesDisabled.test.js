const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Auto-update must stay off in this build, and the consequence of it silently coming
// back is severe: the feed points at OpenWhispr/openwhispr, so an "update" would
// replace this fork with an upstream build that has none of its changes — and with
// autoInstallOnAppQuit it would do that on the next quit without asking again.
//
// A static scan rather than a behavioural test because the thing being guarded is the
// absence of network calls at startup, which is exactly what a unit test with a mocked
// autoUpdater would fail to notice.

const ROOT = path.join(__dirname, "..", "..");
const source = fs.readFileSync(path.join(ROOT, "src", "updater.js"), "utf8");

/** The body of a method, from its signature to the next top-level method. */
function methodBody(name) {
  // Matches both `  name(` and `  async name(`.
  const signature = new RegExp(`\\n  (?:async )?${name}\\(`);
  const match = signature.exec(source);
  assert.ok(match, `${name} not found — was it renamed?`);
  const start = match.index;
  const rest = source.slice(start + match[0].length);
  const next = rest.search(/\n {2}(?:async )?[a-zA-Z_]+\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

test("the kill switch is on", () => {
  // The switch lives in buildFeatures.json so the renderer reads the same answer as the
  // main process; the module must derive from it rather than carry its own literal.
  const features = JSON.parse(
    fs.readFileSync(path.join(ROOT, "src", "config", "buildFeatures.json"), "utf8")
  );
  assert.equal(features.autoUpdate, false, "auto-update must stay off in buildFeatures.json");
  assert.match(source, /UPDATES_DISABLED = buildFeatures\.autoUpdate === false/);
});

test("every entry point that could reach the network is guarded", () => {
  // Each of these either contacts the feed or acts on something it returned.
  for (const name of [
    "setupAutoUpdater",
    "checkForUpdates",
    "downloadUpdate",
    "installUpdate",
    "checkForUpdatesOnStartup",
  ]) {
    assert.match(
      methodBody(name),
      /UPDATES_DISABLED/,
      `${name} must return early when updates are disabled`
    );
  }
});

test("the startup check and the periodic poll are both skipped", () => {
  const body = methodBody("checkForUpdatesOnStartup");
  // The guard has to precede both the 3s startup check and the 4-hourly interval,
  // or one of them still runs.
  const guardAt = body.indexOf("UPDATES_DISABLED");
  const timeoutAt = body.indexOf("setTimeout");
  const intervalAt = body.indexOf("setInterval");
  assert.ok(guardAt !== -1, "no guard");
  assert.ok(timeoutAt === -1 || guardAt < timeoutAt, "guard must precede the startup check");
  assert.ok(intervalAt === -1 || guardAt < intervalAt, "guard must precede the poll");
});

test("a previously downloaded update cannot install itself on quit", () => {
  // The dangerous default. An earlier build of this app had autoInstallOnAppQuit
  // true, so a pending download from back then must be countermanded rather than
  // merely not added to.
  assert.match(methodBody("setupAutoUpdater"), /autoInstallOnAppQuit = false/);
  assert.match(methodBody("setupAutoUpdater"), /autoDownload = false/);
});

test("the renderer is told, so no UI offers an update", () => {
  assert.match(methodBody("getUpdateStatus"), /updatesDisabled: UPDATES_DISABLED/);

  const settings = fs.readFileSync(
    path.join(ROOT, "src", "components", "SettingsPage.tsx"),
    "utf8"
  );
  assert.match(
    settings,
    /!updateStatus\.updatesDisabled/,
    "the settings UI must consult the flag rather than assuming updates work"
  );
});

test("the feed still points at upstream, which is why this is switched off", () => {
  // If this ever stops being true the comment above is stale and the reasoning here
  // needs revisiting — a fork with its own release feed could safely update.
  assert.match(source, /owner: "OpenWhispr"/);
  assert.match(source, /repo: "openwhispr"/);
});
