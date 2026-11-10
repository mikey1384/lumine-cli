import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";
import { formatPreview3dResult } from "../lib/admin-preview-3d.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", ...args]));

test("preview-3d status is a run-free read", () => {
  for (const status of [op("preview-3d", "status"), op("preview-3d")]) {
    assert.equal(status.name, "preview-3d.status");
    assert.equal(status.method, "GET");
    assert.equal(status.path, "/cli/admin/preview-3d/status");
    assert.equal(status.mutates, false);
    assert.equal(status.requiresRun, false);
  }
});

test("preview-3d switch sends only on or off and needs no run", () => {
  const off = op("preview-3d", "switch", "--mode", "off");
  assert.equal(off.method, "POST");
  assert.equal(off.path, "/cli/admin/preview-3d/switch");
  assert.deepEqual(off.body, { mode: "off" });
  assert.equal(off.mutates, true);
  assert.equal(off.requiresRun, false);
  assert.deepEqual(op("preview-3d", "switch", "--mode", "on").body, { mode: "on" });
  assert.throws(() => op("preview-3d", "switch"), /--mode is on or off/);
  assert.throws(() => op("preview-3d", "switch", "--mode", "paused"), /--mode is on or off/);
  assert.throws(() => op("preview-3d", "restart"), /Usage: lumine admin preview-3d/);
});

test("preview-3d results say what is true now, including an unreadable switch", () => {
  assert.match(formatPreview3dResult({ operation: { name: "preview-3d.switch" }, data: { mode: "off", effectiveWithinSeconds: 30 } }).join("\n"), /3D preview: off \(confirmed by reading it back.*30 s\)[\s\S]*without 3D/);
  assert.match(formatPreview3dResult({ operation: { name: "preview-3d.status" }, data: { mode: "on", source: "default" } })[0], /on · the default \(never switched\)/);
  const unreadable = formatPreview3dResult({ operation: { name: "preview-3d.status" }, data: { mode: "on", source: "store_unavailable", notice: "The switch table is missing." } });
  assert.match(unreadable[0], /could not be read/);
  assert.match(unreadable[1], /switch table is missing/);
});
