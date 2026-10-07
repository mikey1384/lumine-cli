import assert from "node:assert/strict";
import test from "node:test";
import { formatTeacherReviewLine, parseAdminOperation } from "../lib/admin.js";
import { receiptToKeep } from "../lib/admin-receipts.js";
import { printTeacherBranchResult } from "../lib/admin-teacher-branches.js";
import { parseArgs } from "../lib/commands.js";

// `lumine admin teachers branches …`: the owner-confirmed teacher branch registry.
const op = (...args) => parseAdminOperation(parseArgs(["admin", "teachers", "branches", ...args]));

test("teacher branch commands map to owner-only API requests", () => {
  assert.deepEqual(
    [op("suggest").method, op("suggest").path, op("suggest").mutates, op("suggest").requiresRun],
    ["GET", "/cli/admin/teachers/branches/suggest", false, false],
  );
  assert.equal(op("networks").path, "/cli/admin/teachers/branches/networks");
  assert.equal(op().path, "/cli/admin/teachers/branches");
  assert.equal(op("list", "--branch", "Twinkle U").path, "/cli/admin/teachers/branches?branch=Twinkle%20U");
  const confirm = op("confirm", "A1B2C3D4E5", "--branch", "Daechi", "--note", "front desk");
  assert.deepEqual(
    [confirm.name, confirm.method, confirm.path, confirm.body, confirm.mutates],
    ["teachers.branches.confirm", "POST", "/cli/admin/teachers/branches/networks/a1b2c3d4e5", { branches: ["Daechi"], note: "front desk" }, true],
  );
  const unconfirm = op("unconfirm", "a1b2c3d4e5");
  assert.deepEqual([unconfirm.path, unconfirm.mutates], ["/cli/admin/teachers/branches/networks/a1b2c3d4e5/unconfirm", true]);
  const set = op("set", "Ms Kim", "--branch", "Mokdong");
  assert.deepEqual([set.path, set.body], ["/cli/admin/teachers/branches/teacher/Ms%20Kim", { branch: "Mokdong" }]);
  assert.equal(op("clear", "812").path, "/cli/admin/teachers/branches/teacher/812/clear");
  const apply = op("apply");
  assert.deepEqual([apply.name, apply.method, apply.path, apply.mutates], ["teachers.branches.apply", "POST", "/cli/admin/teachers/branches/apply", true]);
});

test("a building two branches share: --branch repeats, or --branches A,B", () => {
  for (const args of [
    ["--branch", "Mokdong", "--branch", "TwinkleU"],
    ["--branch=Mokdong", "--branch=TwinkleU"],
    ["--branches", "Mokdong,TwinkleU"],
    ["--branch", "Mokdong", "--branches", "TwinkleU,Mokdong"],
  ]) {
    assert.deepEqual(op("confirm", "a1b2c3d4e5", ...args).body.branches, ["Mokdong", "TwinkleU"]);
  }
});

test("teacher branch commands refuse what they cannot send", () => {
  assert.throws(() => op("confirm", "a1b2c3d4e5"), /needs --branch/);
  assert.throws(() => op("confirm", "58.151.80.59", "--branch", "Daechi"), /10-character id/);
  assert.throws(() => op("set", "812"), /exactly one --branch/);
  assert.throws(() => op("set", "812", "--branch", "Daechi", "--branch", "Mokdong"), /exactly one --branch/);
  assert.throws(() => op("set", "--branch", "Daechi"), /teachers branches suggest/);
  assert.throws(() => op("nonsense"), /teachers branches suggest \| networks/);
});

test("an apply receipt keeps counts and changes, not the teacher lists", () => {
  const receipt = receiptToKeep(
    { name: "teachers.branches.apply" },
    {
      ok: true,
      status: "success",
      changed: true,
      data: {
        counts: { assigned: 3, ambiguous: 1 },
        changes: [
          { userId: 7, username: "kim", from: null, to: "Daechi", share: 97, actions: 140, days: 31 },
          { userId: 6, username: "park", from: "Mokdong", to: null },
        ],
        lowEvidence: [{ userId: 5, username: "choi", branch: "Daechi", actions: 4, days: 1 }],
        ambiguous: [{ userId: 8, username: "lee", typedBranch: "Daechi and Mokdong" }],
        differsFromTyped: [{ userId: 9 }],
      },
    },
  );
  assert.deepEqual(receipt.data, {
    counts: { assigned: 3, ambiguous: 1 },
    changes: [
      { userId: 7, from: null, to: "Daechi", share: 97, actions: 140, days: 31 },
      { userId: 6, from: "Mokdong", to: null },
    ],
  });
});

test("the teacher audit line shows the confirmed branch", () => {
  const entry = { account: { userId: 7, username: "kim" }, flags: [], reviewStatus: "clean" };
  assert.doesNotMatch(formatTeacherReviewLine(entry), /Daechi/);
  assert.match(
    formatTeacherReviewLine({ ...entry, branch: { branchKey: "daechi", displayName: "Daechi", source: "owner" } }),
    /kim \(#7\) · Daechi \(set by owner\)/,
  );
});

test("suggest and apply print what Mikey decides on", () => {
  const lines = [];
  const log = console.log;
  console.log = (line = "") => lines.push(String(line));
  try {
    printTeacherBranchResult({
      operation: { name: "teachers.branches.suggest" },
      data: {
        windowDays: 365,
        academyMinAccounts: 15,
        teachers: 289,
        networks: [
          {
            networkId: "a1b2c3d4e5",
            address: "175.197.x.166",
            accounts: 153,
            teachers: 9,
            teacherActions: 4000,
            firstAt: 1_790_000_000,
            lastAt: 1_791_000_000,
            suggested: { branchKey: "mokdong", displayName: "Mokdong" },
            tiedWith: [],
            typed: [{ branch: "Mokdong", teachers: 4 }, { branch: "TwinkleU", teachers: 2 }],
            topTeachers: [{ userId: 7, username: "kim", typedBranch: "TwinkleU", actions: 900 }],
            confirmed: { branches: [{ displayName: "Mokdong" }, { displayName: "TwinkleU" }], note: "" },
          },
        ],
        confirmedNotSeen: [],
        officialBranches: [{ displayName: "Mokdong" }, { displayName: "TwinkleU" }],
      },
    });
    printTeacherBranchResult({
      operation: { name: "teachers.branches.apply" },
      data: {
        counts: { teachers: 5, confirmedNetworks: 1, assigned: 1, ambiguous: 1, lowEvidence: 1, minDays: 3, unknown: 1, ownerSet: 0, notRead: 1, notReadBy: { replica_busy: 1, time_limit: 0, time_budget: 0 }, changed: 1, differsFromTyped: 0 },
        changes: [{ userId: 7, username: "kim", from: null, to: "TwinkleU", share: 100, actions: 40, days: 9 }],
        lowEvidence: [{ userId: 9, username: "choi", branch: "Daechi", share: 100, actions: 4, days: 1, typedBranch: "" }],
        ambiguous: [{ userId: 8, username: "lee", candidates: ["Mokdong", "TwinkleU"], split: "Mokdong/TwinkleU 100%", typedBranch: "", reason: "mostly on a network Mokdong and TwinkleU share" }],
        unknownReasons: { "no actions on a confirmed network": 1 },
      },
    });
  } finally {
    console.log = log;
  }
  const out = lines.join("\n");
  assert.match(out, /a1b2c3d4e5 {2}175\.197\.x\.166 · 153 accounts · 9 teachers/);
  assert.match(out, /CONFIRMED: Mokdong \+ TwinkleU/);
  assert.match(out, /1 assigned, 1 ambiguous, 1 low evidence \(under 3 days\), 1 unknown, 0 set by owner, 1 not read \(1 replica busy\)/);
  assert.match(out, /kim \(#7\): none → TwinkleU \(100% · 40 actions on 9 day\(s\)\)/);
  assert.match(out, /Low evidence, not assigned[\s\S]*choi \(#9\) · Daechi 100% · 4 actions on 1 day\(s\)/);
  assert.match(out, /lee \(#8\) · Mokdong or TwinkleU/);
});
