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

const fs = require("fs");
const { execFileSync, spawnSync } = require("child_process");

const LOCAL_DEVELOPMENT_ROOT = "OpenWhispr Local Development Root";

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
    const match = line.match(/^\s*\d+\)\s+([0-9A-F]+)\s+"(.+)"\s*$/);
    if (match) found.push({ hash: match[1], name: match[2] });
  }

  // Developer ID is the only one that also satisfies Gatekeeper for other people, so it
  // wins when present. Apple Development is enough for the permissions problem, which is
  // what this script is for.
  const rank = ({ name }) => {
    if (name.startsWith("Developer ID Application")) return 0;
    if (name.startsWith("Apple Development")) return 1;
    if (name === LOCAL_DEVELOPMENT_ROOT) return 2;
    if (name.startsWith("Mac Developer")) return 3;
    return 4;
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

console.log(`[dist-local] signing identity: ${identity.name} (${identity.hash})`);
if (identities.length > 1) {
  console.log(
    `[dist-local] (also available: ${identities
      .slice(1)
      .map(({ name }) => name)
      .join(", ")})`
  );
}

// better-sqlite3 must be built against Electron's ABI, not Node's.
//
// Running the test suite requires the opposite build (`npm rebuild better-sqlite3`),
// and whichever one ran last is the one that gets packaged. Ship the Node build and the
// app dies on launch with "compiled against a different Node.js version using
// NODE_MODULE_VERSION 131 ... requires 145" — which has happened twice, both times
// discovered by installing it rather than by building it.
//
// The check is inverted on purpose: the correct binary is the one this Node *cannot*
// load. Nothing else distinguishes them, since both live at the same path.
{
  const probe = spawnSync(process.execPath, ["-e", "new (require('better-sqlite3'))(':memory:')"], {
    encoding: "utf8",
    cwd: __dirname + "/..",
  });
  if (probe.status === 0) {
    console.error(
      "[dist-local] better-sqlite3 is built for Node, not Electron — packaging it would\n" +
        "            produce an app that crashes on launch. Rebuild it first:\n\n" +
        "              npx @electron/rebuild -f -o better-sqlite3\n"
    );
    process.exit(1);
  }
  if (!/NODE_MODULE_VERSION/.test(probe.stderr || "")) {
    console.error(
      "[dist-local] could not determine better-sqlite3's ABI. It failed to load for some\n" +
        "            reason other than an ABI mismatch, so this build is not verified:\n\n" +
        (probe.stderr || "").trim().split("\n").slice(0, 5).join("\n")
    );
    process.exit(1);
  }
  console.log("[dist-local] better-sqlite3 is built for Electron's ABI.");
}

// Compile the modern macOS icon when the local Xcode installation supports it. If it
// does not, omit that one optional resource so electron-builder can use icon.icns
// instead of failing because Assets.car is absent.
{
  const result = spawnSync("npm", ["run", "compile:mac-icon"], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const builderArgs = [
  "exec",
  "--",
  "electron-builder",
  // Use the certificate hash, not its display name. The old development leaf has a
  // name that is a prefix of the stable root, so name-based matching can select the
  // wrong identity and make TCC grants change again.
  `--config.mac.identity=${identity.hash}`,
  "--config.mac.notarize=false",
];
if (!fs.existsSync("src/assets/Assets.car")) {
  console.log("[dist-local] Assets.car unavailable; using the legacy icon.icns fallback.");
  builderArgs.push("--config.mac.extraResources=[]");
}

// build:renderer first, always. Calling electron-builder without it ships a stale
// renderer bundle — the build looks clean and the app is silently a version behind.
for (const args of [["run", "build:renderer"], builderArgs]) {
  const result = spawnSync("npm", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Print the requirement that was actually produced, so a regression back to a cdhash
// requirement is visible at build time rather than discovered as lost permissions.
const app = "dist/mac-arm64/OpenWhispr.app";
try {
  // `codesign -d` writes its report to stderr even on success. execFileSync's return
  // value is stdout, so the previous check always read an empty string and could never
  // verify the requirement it claimed to verify.
  const probe = spawnSync("codesign", ["-d", "-r-", app], {
    encoding: "utf8",
  });
  if (probe.status !== 0) throw new Error((probe.stderr || "codesign failed").trim());
  const requirement = `${probe.stdout || ""}\n${probe.stderr || ""}`;
  const line = requirement.split("\n").find((l) => l.includes("designated =>")) ?? "";
  if (!line) throw new Error("codesign did not report a designated requirement");
  console.log(`\n[dist-local] ${line.trim()}`);
  if (line.includes("cdhash")) {
    console.error(
      "[dist-local] WARNING: requirement is still cdhash-based — permissions will reset on reinstall."
    );
    process.exit(1);
  }
  console.log("[dist-local] Requirement is identity-based, so permissions survive reinstalls.");
} catch (error) {
  console.error(
    `[dist-local] could not verify the designated requirement: ${error?.message || error}`
  );
  process.exit(1);
}
