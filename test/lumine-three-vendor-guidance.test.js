import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BUILD_VENDOR_THREE_ADDONS_IMPORT_PREFIX,
  BUILD_VENDOR_THREE_MODULE_IMPORT,
  LUMINE_THREE_VENDOR_GUIDANCE,
} from "../lib/constants.js";
import { buildRuntimeAssetsProbeHtml } from "../lib/doctor.js";
import { writeAgentInstructions } from "../lib/workspace.js";

test("generated external-agent guides advertise the supported Three.js surface carefully", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lumine-three-guide-"));
  try {
    await writeAgentInstructions({ dir });
    const guides = await Promise.all(
      ["AGENTS.md", "CLAUDE.md"].map((fileName) =>
        fs.readFile(path.join(dir, fileName), "utf8"),
      ),
    );

    for (const guide of guides) {
      assert.match(guide, new RegExp(escapeRegExp(BUILD_VENDOR_THREE_MODULE_IMPORT)));
      assert.match(
        guide,
        new RegExp(escapeRegExp(BUILD_VENDOR_THREE_ADDONS_IMPORT_PREFIX)),
      );
      assert.match(
        guide,
        new RegExp(
          escapeRegExp(
            `${BUILD_VENDOR_THREE_ADDONS_IMPORT_PREFIX}postprocessing/EffectComposer.js`,
          ),
        ),
      );
      assert.match(
        guide,
        /EffectComposer, RenderPass, SSAOPass\/GTAOPass, UnrealBloomPass, and OutputPass/,
      );
      assert.match(
        guide,
        /absence there is not evidence that an official addon is unavailable/,
      );
      assert.match(
        guide,
        /WebGL EffectComposer passes do not work with WebGPURenderer/,
      );
      assert.match(guide, /Treat addons as available tools, not defaults/);
      assert.match(guide, /not arbitrary third-party Three\.js packages/);
      assert.match(
        guide,
        /Do not remove or disable a requested visual effect as a performance tradeoff without the user's explicit approval/,
      );
      assert.match(guide, /never mix the legacy core with current addons/);
      assert.match(guide, /caps render pixel ratio around 1-1\.25/);
      assert.match(guide, /Size both WebGLRenderer and EffectComposer/);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the reusable Three.js guidance stays bounded", () => {
  assert.ok(LUMINE_THREE_VENDOR_GUIDANCE.length < 2_500);
});

test("the runtime-asset doctor uses the same addon prefix as the agent guide", () => {
  const html = buildRuntimeAssetsProbeHtml({
    hdrUrl: "https://assets.example/env.hdr",
    glbUrl: "https://assets.example/scene.glb",
  });

  assert.match(
    html,
    new RegExp(
      escapeRegExp(
        `${BUILD_VENDOR_THREE_ADDONS_IMPORT_PREFIX}loaders/RGBELoader.js`,
      ),
    ),
  );
  assert.match(
    html,
    new RegExp(
      escapeRegExp(
        `${BUILD_VENDOR_THREE_ADDONS_IMPORT_PREFIX}loaders/GLTFLoader.js`,
      ),
    ),
  );
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
