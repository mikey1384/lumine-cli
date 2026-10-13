import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildBuilderStanceModule,
  findCoreValuesFile,
} from "../scripts/generate-builder-stance.mjs";
import { LUMINE_AGENT_INSTRUCTIONS } from "../lib/constants.js";

// Agents that build through Lumine CLI are tools, not companions (Mikey
// 2026-10-13): CORE_VALUES.md "For building agents" is canonical, and this
// package ships a generated copy inside the workspace AGENTS.md/CLAUDE.md.
const HERE = path.dirname(fileURLToPath(import.meta.url));

test("the generated builder stance matches CORE_VALUES.md", (t) => {
  const source = findCoreValuesFile(path.join(HERE, ".."));
  if (!source) return t.skip("CORE_VALUES.md is not on this machine");
  const expected = buildBuilderStanceModule(fs.readFileSync(source, "utf8"));
  const actual = fs.readFileSync(
    path.join(HERE, "..", "lib", "builderStance.generated.js"),
    "utf8",
  );
  assert.equal(
    actual,
    expected,
    "lib/builderStance.generated.js is stale: run node scripts/generate-builder-stance.mjs",
  );
});

test("workspace agents get the builder stance and nothing private", () => {
  assert.match(LUMINE_AGENT_INSTRUCTIONS, /## Building For The Creator/);
  assert.match(LUMINE_AGENT_INSTRUCTIONS, /What to make is the creator's call/);
  for (const word of ["Mikey", "Notable", "<!--", "Editors'"]) {
    const stance = LUMINE_AGENT_INSTRUCTIONS.split("## Building For The Creator")[1].split("## Source Of Truth")[0];
    assert.ok(!stance.includes(word), `builder stance leaks "${word}"`);
  }
});
