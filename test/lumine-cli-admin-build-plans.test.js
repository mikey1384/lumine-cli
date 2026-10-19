import assert from "node:assert/strict";
import test from "node:test";
import { parseAdminOperation } from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";
import { formatBuildPlansResult } from "../lib/admin-build-plans.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", "build-plans", ...args]));

test("build-plans stuck reads; recheck takes several builds and is a dry run unless --confirm", () => {
  const stuck = op("stuck", "--days", "14", "--all");
  assert.equal(stuck.method, "GET");
  assert.equal(stuck.path, "/cli/admin/build-plans/stuck?days=14&all=1");
  assert.equal(stuck.mutates, false);
  const dry = op("recheck", "863", "373,2685");
  assert.equal(dry.name, "build-plans.recheck.preview");
  assert.equal(dry.mutates, false);
  assert.deepEqual(dry.body, { buildIds: [863, 373, 2685], dryRun: true });
  const real = op("recheck", "863", "--confirm");
  assert.equal(real.name, "build-plans.recheck");
  assert.equal(real.mutates, true);
  assert.equal(real.body.dryRun, false);
  assert.throws(() => op("recheck"), /1 to 10 build ids/);
  assert.throws(() => op("recheck", "abc"), /1 to 10 build ids/);
  assert.throws(() => op("stuck", "--days", "200"), /--days/);
  assert.throws(() => op("fix"), /Usage/);
});

test("build-plans results read plainly", () => {
  const row = {
    buildId: 863, milestoneIndex: 0, milestones: 5, milestonesDone: 0, runs: 29,
    energyRatio: 2.33, evaluations: 26, consecutiveNonPass: 26, passed: 0, criteria: 3,
    unverified: 0, stalled: true, stallReason: "over_budget", wouldStall: null,
    coverage: { shown: 9, total: 66, omittedReferenced: 1, toolRounds: 0, toolFilesRead: 0 },
    flags: ["stalled", "over_estimate"]
  };
  const lines = formatBuildPlansResult({ operation: { name: "build-plans.stuck" }, data: { running: 4, days: 30, rows: [row] } });
  assert.equal(lines[0], "4 running build plan(s) updated in the last 30 days; 1 shown.");
  assert.match(lines[1], /Build 863: milestone 1\/5 \(0 done\), 29 runs, Energy 2.33x of estimate, 26 gradings.*STALLED\(over_budget\).*files 9\/66, 1 referenced omitted \[stalled, over_estimate\]/);
  const done = formatBuildPlansResult({
    operation: { name: "build-plans.recheck" },
    data: { dryRun: false, results: [
      { ok: true, buildId: 863, milestoneIndex: 0, verdict: "PASS", passed: 3, criteria: 3, unverified: 0, milestoneCompleted: true, fileCoverage: { shownFiles: 9, totalFiles: 66, toolFilesRead: 7, toolRounds: 3 } },
      { ok: false, buildId: 1, reason: "no_running_plan" }
    ] }
  });
  assert.equal(done[0], "Build 863: milestone 1 PASS, 3/3 passing, 0 unverified, milestone completed; files 9/66 + 7 read in 3 rounds");
  assert.equal(done[1], "Build 1: not rechecked (no_running_plan)");
});
