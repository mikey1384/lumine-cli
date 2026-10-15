import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseAdminOperation } from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";
import { testWorkRoot } from "./helpers/work-directory.js";

test("full-question inspection uses exact Build and question identifiers without a daily run", () => {
  const op = parseAdminOperation(
    parseArgs([
      "admin",
      "reward-bank",
      "question",
      "2655",
      "--question-id",
      "41",
    ]),
  );
  assert.equal(
    op.path,
    "/cli/admin/reward-bank/question?buildId=2655&questionId=41",
  );
  assert.equal(op.requiresRun, false);
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "reward-bank", "question", "2655"]),
      ),
    /question-id/,
  );
});

test("guarded repair preserves zero and decimal answers, validates the plan, and carries dry-run explicitly", (t) => {
  const directory = fs.mkdtempSync(path.join(testWorkRoot(), "reward-bank-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "repair.json");
  const plan = {
    questionId: 41,
    expectedFingerprint: "a".repeat(64),
    answer: 0.5,
    reason: "Verified arithmetic",
  };
  const parse = (...extra) =>
    parseAdminOperation(
      parseArgs([
        "admin",
        "reward-bank",
        "repair",
        "2655",
        "--file",
        file,
        ...extra,
      ]),
    );
  fs.writeFileSync(file, JSON.stringify(plan));
  const dry = parse("--dry-run");
  assert.equal(dry.path, "/cli/admin/reward-bank/repair");
  assert.deepEqual(dry.body, { buildId: 2655, repair: plan, dryRun: true });
  assert.equal(dry.requiresRun, false);
  assert.equal(dry.mutates, false);
  assert.equal(parse().mutates, true);
  assert.equal(parse().body.dryRun, false);
  fs.writeFileSync(file, JSON.stringify({ ...plan, answer: 0 }));
  assert.equal(parse().body.repair.answer, 0);
  for (const change of [
    { answer: "0.5" },
    { expectedFingerprint: "stale" },
    { prompt: "unauthorized replacement" },
    { reason: "" },
  ]) {
    fs.writeFileSync(file, JSON.stringify({ ...plan, ...change }));
    assert.throws(() => parse(), /Repair JSON/);
  }
});
