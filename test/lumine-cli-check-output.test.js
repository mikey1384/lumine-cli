import test from "node:test";
import assert from "node:assert/strict";
import { printCheck, parseArgs } from "../lib/commands.js";

test("project validation has time to finish while explicit request deadlines remain authoritative", () => {
  const previous = process.env.TWINKLE_TIMEOUT_MS;
  try {
    delete process.env.TWINKLE_TIMEOUT_MS;
    const defaults = parseArgs(["check"]);
    assert.equal(defaults.timeoutMs, 20000);
    assert.equal(defaults.validationTimeoutMs, 150000);
    const explicit = parseArgs(["check", "--timeout-ms", "7000"]);
    assert.equal(explicit.timeoutMs, 7000);
    assert.equal(explicit.validationTimeoutMs, 7000);
    process.env.TWINKLE_TIMEOUT_MS = "9000";
    assert.equal(parseArgs(["check"]).validationTimeoutMs, 9000);
  } finally {
    if (previous === undefined) delete process.env.TWINKLE_TIMEOUT_MS;
    else process.env.TWINKLE_TIMEOUT_MS = previous;
  }
});

test("saved validation cannot be mistaken for approval or permission to publish a contribution", () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    printCheck({
      ok: true,
      launchOk: false,
      checks: {
        canonicalBuild: { ok: false },
        projectFiles: { ok: true, fileCount: 22 },
        toolchain: { ok: true },
        conflictMarkers: { ok: true },
        rewardApproval: {
          ok: false,
          reason: "The revised version needs approval.",
        },
      },
    });
  } finally {
    console.log = original;
  }
  const output = lines.join("\n");
  assert.match(output, /Saved project validation: ok/);
  assert.match(output, /Publishing readiness: blocked/);
  assert.match(output, /save, then suggest/);
  assert.match(output, /main app owner merges and publishes/);
  assert.match(output, /local workspace changes must be saved/);
  assert.match(output, /XP\/Coins approval: blocked/);
  assert.match(output, /revised version needs approval/);
});
