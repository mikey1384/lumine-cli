import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";
import { testWorkRoot } from "./helpers/work-directory.js";

test("todo workflow updates carry the reviewed revision and exact evidence", (t) => {
  const dir = fs.mkdtempSync(path.join(testWorkRoot(), "todo-workflow-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "workflow.json");
  const workflow = {
    implementation: "ready",
    release: "live",
    verification: "pending",
    nextAction: "Verify the exact approved-request flow.",
  };
  fs.writeFileSync(file, JSON.stringify(workflow));
  const args = [
    "admin",
    "todo",
    "update",
    "75",
    "--status",
    "in_progress",
    "--note",
    "Fix deployed; verification remains",
    "--workflow",
    file,
  ];
  assert.throws(() => parseAdminOperation(parseArgs(args)), /revision/);
  const operation = parseAdminOperation(
    parseArgs([...args, "--revision", "6"]),
  );
  assert.deepEqual(operation.body.workflow, workflow);
  assert.equal(operation.body.expectedRevision, 6);
});
