import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";
import { formatSpendCacheCreditResult } from "../lib/admin-spend-cache-credit.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", ...args]));

test("spend-cache-credit status is a run-free read", () => {
  for (const status of [op("spend-cache-credit", "status"), op("spend-cache-credit")]) {
    assert.equal(status.name, "spend-cache-credit.status");
    assert.equal(status.method, "GET");
    assert.equal(status.path, "/cli/admin/spend-cache-credit/status");
    assert.equal(status.mutates, false);
    assert.equal(status.requiresRun, false);
  }
});

test("spend-cache-credit switch sends only on or off and needs no run", () => {
  const off = op("spend-cache-credit", "switch", "--mode", "off");
  assert.equal(off.method, "POST");
  assert.equal(off.path, "/cli/admin/spend-cache-credit/switch");
  assert.deepEqual(off.body, { mode: "off" });
  assert.equal(off.requiresRun, false);
  assert.throws(() => op("spend-cache-credit", "switch"), /--mode is on or off/);
  assert.match(
    formatSpendCacheCreditResult({ operation: off, data: { mode: "off" } }).join("\n"),
    /cold quote/
  );
});
