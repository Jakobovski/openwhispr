const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Retiring a provider is two separable halves, and doing only the second breaks things.
//
// The first attempt deleted tinfoil, corti and mistral from modelRegistryData.json. That
// looked like the clean removal, but the registry is what their own implementations read
// — tinfoil's transcription client resolves its batch model from it — so seven tests
// went red and the client was left broken rather than retired.
//
// So the registry keeps them and the pickers filter them. These checks hold that shape:
// hidden from what can be selected, present for what still runs.

const ROOT = path.join(__dirname, "..", "..");
const registry = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src", "models", "modelRegistryData.json"), "utf8")
);
const modelRegistrySource = fs.readFileSync(
  path.join(ROOT, "src", "models", "ModelRegistry.ts"),
  "utf8"
);
const reasoningSelector = fs.readFileSync(
  path.join(ROOT, "src", "components", "ReasoningModelSelector.tsx"),
  "utf8"
);

const RETIRED = ["tinfoil", "corti", "mistral"];

test("retired providers are still in the registry, so their code keeps working", () => {
  const transcription = registry.transcriptionProviders.map((p) => p.id);
  for (const id of RETIRED) {
    assert.ok(
      transcription.includes(id),
      `${id} was deleted from transcriptionProviders — its client reads its model from there`
    );
  }
});

test("but none of them is offered in the transcription picker", () => {
  for (const id of RETIRED) {
    assert.match(
      modelRegistrySource,
      new RegExp(`"${id}"`),
      `${id} is missing from RETIRED_PROVIDER_IDS, so it is still selectable`
    );
  }
  assert.match(
    modelRegistrySource,
    /getTranscriptionProviders\(\)\s*\.filter\(\(provider\)\s*=>\s*!RETIRED_PROVIDER_IDS\.has\(provider\.id\)\)/,
    "the transcription picker must filter retired providers"
  );
});

test("and none of them is a reasoning tab", () => {
  const tabs = reasoningSelector.slice(
    reasoningSelector.indexOf("const CLOUD_PROVIDER_IDS = ["),
    reasoningSelector.indexOf("];", reasoningSelector.indexOf("const CLOUD_PROVIDER_IDS = ["))
  );
  for (const id of RETIRED) {
    assert.doesNotMatch(tabs, new RegExp(`"${id}"`), `${id} is still a cloud provider tab`);
  }
});

test("local Mistral models are untouched", () => {
  // "mistral" names two different things: the retired cloud API, and the local GGUF
  // family. Only the first was retired, and conflating them would remove working
  // offline models nobody asked to lose.
  const local = registry.localProviders.map((p) => p.id);
  assert.ok(local.includes("mistral"), "the local Mistral family must remain available");
});
