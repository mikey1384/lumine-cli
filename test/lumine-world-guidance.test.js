import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LUMINE_WORLD_UPDATE_GUIDANCE,
  SDK_REFERENCE_FALLBACK,
} from "../lib/constants.js";
import { loadSdkReference, writeAgentInstructions } from "../lib/workspace.js";

test("pulled external-agent guides require bounded coalesced world updates", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lumine-world-guide-"));
  try {
    await writeAgentInstructions({ dir });
    const guides = await Promise.all(
      ["AGENTS.md", "CLAUDE.md"].map((fileName) =>
        fs.readFile(path.join(dir, fileName), "utf8"),
      ),
    );

    for (const guidance of [
      LUMINE_WORLD_UPDATE_GUIDANCE,
      SDK_REFERENCE_FALLBACK,
      ...guides,
    ]) {
      assert.match(guidance, /only when relevant state changes/);
      assert.match(guidance, /replace any queued snapshot with the newest one/);
      assert.match(guidance, /at most one updatePresence request in flight/);
      assert.match(guidance, /Never call or await updatePresence every animation frame/);
      assert.match(guidance, /without an immediate retry/);
      assert.match(guidance, /WORLD_EVENT_RATE_LIMITED/);
    }

    const sdkReference = await loadSdkReference();
    assert.match(sdkReference, /only after relevant fields change/);
    assert.match(sdkReference, /at most one updatePresence request in flight/);
    assert.match(sdkReference, /without an immediate retry/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
