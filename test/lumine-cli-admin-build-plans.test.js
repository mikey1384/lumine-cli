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
  const lines = formatBuildPlansResult({ operation: { name: "build-plans.stuck" }, data: { running: 4, inWindow: 2, stalled: 1, days: 30, rows: [row] } });
  assert.equal(lines[0], "4 running build plan(s); 2 updated in the last 30 days or stalled (1 stalled); 1 shown.");
  assert.match(lines[1], /Build 863: milestone 1\/5 \(0 done\), 29 runs, Energy 2.33x of estimate, 26 gradings.*STALLED\(over_budget\).*files 9\/66, 1 referenced omitted \[stalled, over_estimate\]/);
  const done = formatBuildPlansResult({
    operation: { name: "build-plans.recheck" },
    data: { dryRun: false, errors: [{ value: "abc", reason: "not_a_build_id" }], results: [
      { ok: true, buildId: 863, milestoneIndex: 0, verdict: "PASS", passed: 3, criteria: 3, unverified: 0, milestoneCompleted: true, fileCoverage: { shownFiles: 9, totalFiles: 66, toolFilesRead: 7, toolRounds: 3 } },
      { ok: false, buildId: 1, reason: "no_running_plan" },
      { ok: false, buildId: 2, reason: "run_in_progress" },
      { ok: true, replayed: true, buildId: 3, milestoneIndex: 1, verdict: "NEEDS_WORK", passed: 1, criteria: 2, unverified: 1, usage: { energyUnits: 2400, inputTokens: 40000, outputTokens: 4000 } }
    ] }
  });
  assert.equal(done[0], 'Skipped "abc": not a build id');
  assert.equal(done[1], "Build 863: milestone 1 PASS, 3/3 passing, 0 unverified, milestone completed; files 9/66 + 7 read in 3 rounds");
  assert.equal(done[2], "Build 1: not rechecked (no_running_plan)");
  assert.equal(done[3], "Build 2: not rechecked (a Lumine run is in progress; try again later)");
  assert.equal(done[4], "(already rechecked by this request) Build 3: milestone 2 NEEDS_WORK, 1/2 passing, 1 unverified; cost 2400 Energy units (40000 in / 4000 out tokens), not charged to the creator");
});

test("build-plan output separates criterion success from promised-step coverage, including legacy unknowns", () => {
  const row = {
    buildId: 1696, milestoneIndex: 1, milestones: 5, milestonesDone: 1, runs: 1,
    energyRatio: 0.1, evaluations: 1, consecutiveNonPass: 0, passed: 3, criteria: 3,
    unverified: 0, steps: 4, stepsPassed: 3, stepsUnverified: 0, stepsNeedWork: 1,
    stalled: false, wouldStall: null, flags: ["criteria_pass_steps_open"]
  };
  const operation = { name: "build-plans.stuck" };
  const text = formatBuildPlansResult({ operation, data: { rows: [row], days: 7 } }).join("\n");
  assert.match(text, /3\/3 passing, 0 unverified; steps 3\/4 verified, 0 unverified, 1 need work/);
  assert.match(text, /criteria_pass_steps_open/);
  const legacy = formatBuildPlansResult({ operation, data: { rows: [{ ...row, stepsPassed: null, stepsUnverified: null, stepsNeedWork: null }] } }).join("\n");
  assert.match(legacy, /steps \?\/4 verified \(no step grading yet\)/);
  const recheck = formatBuildPlansResult({ operation: { name: "build-plans.recheck" }, data: { results: [{ ...row, ok: true, verdict: "NEEDS_WORK" }] } }).join("\n");
  assert.match(recheck, /steps 3\/4 verified, 0 unverified, 1 need work/);
  assert.doesNotMatch(recheck, /milestone completed/);
});
