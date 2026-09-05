import assert from "node:assert/strict";
import test from "node:test";
import { parseAdminOperation } from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";

test("runtime evidence is host-bound, read-only and independent of a daily run/log lease", () => {
  for (const host of ["primary", "target"]) {
    const operation = parseAdminOperation(parseArgs(["admin", "runtime", "evidence", host, "--days", "3", "--json"]));
    assert.equal(operation.name, "runtime.evidence");
    assert.equal(operation.method, "GET");
    assert.equal(operation.path, `/cli/admin/runtime-logs/hosts/${host}/evidence?days=3`);
    assert.equal(operation.mutates, false);
    assert.equal(operation.requiresRun, false);
  }
  const operation = parseAdminOperation(parseArgs(["admin", "runtime", "evidence"]));
  assert.equal(operation.path, "/cli/admin/runtime-logs/hosts/primary/evidence?days=7");
  for (const args of [["elsewhere"], ["primary", "extra"], ["--days", "0"], ["--days", "8"], ["--days", "abc"]]) {
    assert.throws(() => parseAdminOperation(parseArgs(["admin", "runtime", "evidence", ...args])));
  }
});
