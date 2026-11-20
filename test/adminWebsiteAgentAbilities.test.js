import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", "website-agent", ...args]));

test("abilities is a bounded, run-free read and supports a single member", () => {
  assert.deepEqual(op("abilities", "--json"), {
    name: "website-agent.abilities", method: "GET", path: "/cli/admin/website-agent/abilities?days=1",
    body: undefined, mutates: false, requiresRun: false
  });
  assert.equal(op("abilities", "--days", "30", "--user", "9").path, "/cli/admin/website-agent/abilities?days=30&memberId=9");
  for (const args of [["abilities","--days","0"], ["abilities","--days","31"], ["abilities","--days","1.5"],
    ["abilities","--user","-1"], ["abilities","--user","someone"], ["abilities","--user","4294967296"], ["delete"], ["abilities","extra"]])
    assert.throws(() => op(...args));
});
