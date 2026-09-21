import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeAgentInstructions, writeSdkReference } from "../lib/workspace.js";

test("new and refreshed CLI workspaces teach agents to evaluate JEV adoption with the bundled contract", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lumine-jev-guidance-"));
  try {
    for (const refresh of [false, true]) {
      if (refresh) await fs.writeFile(path.join(dir, "TWINKLE_BUILD_SDK.md"), "<!-- Lumine CLI SDK Reference -->\nOld reference\n");
      await writeAgentInstructions({ dir });
      await writeSdkReference({ dir });
      for (const file of ["AGENTS.md", "CLAUDE.md"]) {
        const guide = await fs.readFile(path.join(dir, file), "utf8");
        assert.match(guide, /When planning a new app/);
        assert.match(guide, /AI decision design/);
        assert.match(guide, /Twinkle\.ai\.decide/);
        assert.match(guide, /do not wait for\s+the creator/);
      }
      const reference = await fs.readFile(path.join(dir, "TWINKLE_BUILD_SDK.md"), "utf8");
      assert.match(reference, /## AI decision design/);
      assert.match(reference, /async decide\(\{ state, questions \}\)/);
      assert.match(reference, /Choice:.*type: 'choice'/);
      assert.match(reference, /Score:.*type: 'score'/);
      assert.match(reference, /Yes\/no probability:.*type: 'noul'/);
      assert.match(reference, /latency plus AI Energy/);
      assert.match(reference, /ordinary code/);
      assert.doesNotMatch(reference, /Old reference/);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
