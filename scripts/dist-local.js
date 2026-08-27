#!/usr/bin/env node

/**
 * Local macOS build that keeps its system permissions across reinstalls.
 *
 * The problem this exists to solve: macOS TCC (Microphone, Accessibility, Screen
 * Recording) stores a grant against an app's *designated requirement*. For an ad-hoc or
 * unsigned build that requirement is a bare cdhash — a hash of the binary itself:
 *
 *   designated => cdhash H"1b15eab9bf036cc6e1f4283dede0467a542c05bb"
 *
 * Every rebuild changes the binary, so the cdhash changes, so macOS considers it a
 * different app and every permission has to be granted again. Signing with any
 * certificate that has a stable identity replaces that with an identifier-and-certificate
 * requirement, which does not change between builds:
 *
 *   designated => identifier "com.gizmolabs.openwhispr" and anchor apple generic
 *                 and certificate leaf[subject.CN] = "Apple Development: ..."
 *
 * So this picks the best signing identity actually present in the keychain instead of
 * the Developer ID named in electron-builder.json, which is not installed here and
 * causes electron-builder to silently skip signing altogether.
 *
 * Notarization is off: it needs Apple credentials this build does not have, and a
 * locally installed app does not need it once quarantine is cleared.
 */

const { execFileSync, spawnSync } = require("child_process");

/** Codesigning identities in the keychain, best for this purpose first. */
function findIdentities() {
  let raw = "";
  try {
    raw = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }

  const found = [];
  for (const line of raw.split("\n")) {
    // e.g. `  1) ABC123 "Apple Development: someone@example.com (TEAMID)"`
    const match = line.match(/^\s*\d+\)\s+[0-9A-F]+\s+"(.+)"\s*$/);
    if (match) found.push(match[1]);
  }

  // Developer ID is the only one that also satisfies Gatekeeper for other people, so it
  // wins when present. Apple Development is enough for the permissions problem, which is
  // what this script is for.
  const rank = (name) => {
    if (name.startsWith("Developer ID Application")) return 0;
    if (name.startsWith("Apple Development")) return 1;
    if (name.startsWith("Mac Developer")) return 2;
    return 3;
  };
  return found.sort((a, b) => rank(a) - rank(b));
}

const identities = findIdentities();
const identity = identities[0];

if (!identity) {
  // Deliberately not a silent fall back to ad-hoc: that is the state that loses
  // permissions on every reinstall, and doing it quietly is how the problem hides.
  console.error(
    [
      "[dist-local] No codesigning identity found in the keychain.",
      "",
      "  An unsigned or ad-hoc build gets a cdhash-based designated requirement, so",
      "  macOS resets Microphone / Accessibility / Screen Recording on every reinstall.",
      "",
      "  Either install a signing certificate, or build with `npm run dist` and accept",
      "  re-granting permissions each time.",
    ].join("\n")
  );
  process.exit(1);
}

console.log(`[dist-local] signing identity: ${identity}`);
if (identities.length > 1) {
  console.log(`[dist-local] (also available: ${identities.slice(1).join(", ")})`);
}

// build:renderer first, always. Calling electron-builder without it ships a stale
// renderer bundle — the build looks clean and the app is silently a version behind.
for (const args of [
  ["run", "build:renderer"],
  [
    "exec",
    "--",
    "electron-builder",
    `--config.mac.identity=${identity}`,
    "--config.mac.notarize=false",
  ],
]) {
  const result = spawnSync("npm", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Print the requirement that was actually produced, so a regression back to a cdhash
// requirement is visible at build time rather than discovered as lost permissions.
const app = "dist/mac-arm64/OpenWhispr.app";
try {
  const requirement = execFileSync("codesign", ["-d", "-r-", app], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const line = requirement.split("\n").find((l) => l.includes("designated =>")) ?? "";
  console.log(`\n[dist-local] ${line.trim()}`);
  if (line.includes("cdhash")) {
    console.error(
      "[dist-local] WARNING: requirement is still cdhash-based — permissions will reset on reinstall."
    );
    process.exit(1);
  }
  console.log("[dist-local] Requirement is identity-based, so permissions survive reinstalls.");
} catch {
  console.log("[dist-local] (could not read the designated requirement to verify it)");
}
