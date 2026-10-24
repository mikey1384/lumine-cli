import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LUMINE_PLATFORM_RULES } from "../lib/platformRules.generated.js";
import {
  LUMINE_AGENT_INSTRUCTIONS,
  SDK_REFERENCE_FALLBACK,
} from "../lib/constants.js";

// The platform rules (ways an app breaks inside Twinkle's sandboxed frame)
// live in twinkle-api constants/buildSdkManifest.json and reach this package
// through twinkle-api/scripts/generate-build-sdk-index.mjs, so workspace
// agents and the server's Lumine read the same words.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(HERE, "..", "..", "twinkle-api", "constants", "buildSdkManifest.json");

test("the generated platform rules match the SDK manifest", (t) => {
  if (!fs.existsSync(MANIFEST)) return t.skip("twinkle-api is not beside this package");
  const { platformRules } = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const lines = platformRules.rules.map((entry, index) => `${index + 1}. ${entry.rule}`);
  assert.equal(
    LUMINE_PLATFORM_RULES,
    [platformRules.summary, "", ...lines].join("\n"),
    "lib/platformRules.generated.js is stale: run node twinkle-api/scripts/generate-build-sdk-index.mjs",
  );
});

test("workspace agents read the platform rules before anything else they must follow", () => {
  const rules = LUMINE_AGENT_INSTRUCTIONS.indexOf("## Platform Rules");
  assert.ok(rules > 0, "workspace guide has no Platform Rules section");
  assert.ok(rules < LUMINE_AGENT_INSTRUCTIONS.indexOf("## Source Of Truth"));
  assert.ok(LUMINE_AGENT_INSTRUCTIONS.includes(LUMINE_PLATFORM_RULES));
  assert.ok(SDK_REFERENCE_FALLBACK.includes(LUMINE_PLATFORM_RULES));
  assert.match(LUMINE_PLATFORM_RULES, /data-twinkle-document/);
  assert.match(LUMINE_PLATFORM_RULES, /confirm\(\) always returns false/);
});
