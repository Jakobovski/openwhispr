const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Automatic meeting detection is off in this build. Three sources fed it — a mic-usage
// listener, a poll of running processes, and calendar reminders — and all three existed
// only to raise a prompt, so with the prompt gone the sidecar and the poll are pure
// cost. A static scan because what is being guarded is the absence of a started
// sidecar, which a unit test with mocked detectors would not notice.
//
// What must keep working: starting a meeting note deliberately. startManualMeeting and
// joinCalendarMeeting do not depend on the detectors, and a guard added to either would
// break the meeting hotkey — so their absence from the guarded set is asserted too.

const ROOT = path.join(__dirname, "..", "..");
const source = fs.readFileSync(
  path.join(ROOT, "src", "helpers", "meetingDetectionEngine.js"),
  "utf8"
);

function methodBody(name) {
  const signature = new RegExp(`\\n  (?:async )?${name}\\(`);
  const match = signature.exec(source);
  assert.ok(match, `${name} not found — was it renamed?`);
  const rest = source.slice(match.index + match[0].length);
  const next = rest.search(/\n {2}(?:async )?[a-zA-Z_]+\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

test("the switch is off in buildFeatures.json", () => {
  const features = JSON.parse(
    fs.readFileSync(path.join(ROOT, "src", "config", "buildFeatures.json"), "utf8")
  );
  assert.equal(features.meetingDetection, false);
  assert.match(source, /MEETING_DETECTION_DISABLED = buildFeatures\.meetingDetection === false/);
});

test("no detector is started", () => {
  // start() is the only thing that spawns the mic-listener sidecar and begins the
  // process poll, so its early return is what makes this free rather than merely quiet.
  const body = methodBody("start");
  const guardAt = body.indexOf("MEETING_DETECTION_DISABLED");
  assert.ok(guardAt !== -1, "start() must return early");
  const audioAt = body.indexOf("audioActivityDetector.start");
  const processAt = body.indexOf("meetingProcessDetector.start");
  assert.ok(audioAt === -1 || guardAt < audioAt, "guard must precede the mic listener");
  assert.ok(processAt === -1 || guardAt < processAt, "guard must precede the process poll");
});

test("the renderer cannot turn the detectors back on", () => {
  // The renderer syncs notification preferences to the main process on every launch,
  // and setPreferences starts or stops the detectors from them — so without a guard the
  // sidecar would come back up moments after start() declined to launch it.
  assert.match(methodBody("setPreferences"), /MEETING_DETECTION_DISABLED/);
});

test("every source is refused at the shared funnel", () => {
  // Mic, process and calendar all converge on _handleDetection, so this is the backstop
  // if a detector is ever started another way.
  assert.match(methodBody("_handleDetection"), /MEETING_DETECTION_DISABLED/);
});

test("starting a meeting deliberately is untouched", () => {
  // The feature being disabled is detection, not meeting notes. A guard in either of
  // these would break the meeting hotkey and the tray.
  assert.doesNotMatch(
    methodBody("startManualMeeting"),
    /MEETING_DETECTION_DISABLED/,
    "the meeting hotkey must still work"
  );
  assert.doesNotMatch(
    methodBody("joinCalendarMeeting"),
    /MEETING_DETECTION_DISABLED/,
    "joining a calendar meeting on purpose must still work"
  );
});

test("the settings UI hides the toggles that would control nothing", () => {
  const settings = fs.readFileSync(
    path.join(ROOT, "src", "components", "SettingsPage.tsx"),
    "utf8"
  );
  assert.match(settings, /buildFeatures\.meetingDetection && \(/);
});
