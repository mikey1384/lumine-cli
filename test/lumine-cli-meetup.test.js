import assert from "node:assert/strict";
import test from "node:test";

import { parseAdminOperation } from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";
import { receiptToKeep } from "../lib/admin-receipts.js";

function op(args) {
  const operation = parseAdminOperation(parseArgs(["admin", "meetup", ...args]));
  return {
    name: operation.name,
    method: operation.method,
    path: operation.path,
    body: operation.body,
    mutates: operation.mutates,
    requiresRun: operation.requiresRun,
  };
}

test("admin meetup operations map to the Mikey-only meetup quest routes", () => {
  assert.deepEqual(op([]), {
    name: "meetup.list",
    method: "GET",
    path: "/cli/admin/meetup-quest/crews?status=review",
    body: undefined,
    mutates: false,
    requiresRun: false,
  });
  assert.equal(
    op(["list", "--status", "completed"]).path,
    "/cli/admin/meetup-quest/crews?status=completed",
  );
  assert.equal(op(["show", "12"]).path, "/cli/admin/meetup-quest/crews/12");
  // the retired five-step reviews are gone
  for (const retired of ["approve-plan", "approve-grownup", "approve-crew", "send-back", "approve", "request-changes", "slot", "resend-email", "parent-reply"]) {
    assert.throws(() => op([retired, "12", "--note", "x"]), /Usage: lumine admin meetup/, retired);
  }
});

test("announce-checkins previews by default and posts only with --send", () => {
  assert.deepEqual(op(["announce-checkins"]), {
    name: "meetup.announce-checkins",
    method: "GET",
    path: "/cli/admin/meetup-quest/announce-checkins?agent=zero",
    body: undefined,
    mutates: false,
    requiresRun: false,
  });
  assert.equal(op(["announce-checkins", "--send"]).method, "POST");
  assert.equal(op(["announce-checkins", "--send"]).mutates, true);
  assert.deepEqual(op(["announce-checkins", "--send", "--as", "Ciel"]).body, { send: true, agent: "ciel" });
  assert.throws(() => op(["announce-checkins", "--as", "grok"]), /--as zero\|ciel/);
});

test("admin meetup story maps to the story approval routes by crew", () => {
  assert.equal(op(["story"]).path, "/cli/admin/meetup-quest/stories");
  assert.equal(op(["story", "list"]).mutates, false);
  assert.equal(op(["story", "show", "12"]).path, "/cli/admin/meetup-quest/stories/by-crew/12");
  assert.deepEqual(op(["story", "approve", "12"]), {
    name: "meetup.story.approve",
    method: "POST",
    path: "/cli/admin/meetup-quest/stories/by-crew/12/approve",
    body: { note: "", announce: true },
    mutates: true,
    requiresRun: false,
  });
  assert.deepEqual(op(["story", "approve", "12", "--no-announce", "--note", "Lovely"]).body, {
    note: "Lovely",
    announce: false,
  });
  assert.equal(
    op(["story", "send-back", "12", "--note", "Use usernames"]).path,
    "/cli/admin/meetup-quest/stories/by-crew/12/send-back",
  );
  assert.throws(() => op(["story", "send-back", "12"]), /needs --note/);
  assert.throws(() => op(["story", "approve", "x"]), /Crew ID/);
  assert.throws(() => op(["story", "delete", "12"]), /Usage: lumine admin meetup story/);
});

test("admin meetup info maps staff's who-are-you check on a member", () => {
  assert.deepEqual(op(["info", "6", "18816", "--decision", "ask", "--note", "Which Bundang class are you in?"]), {
    name: "meetup.info",
    method: "POST",
    path: "/cli/admin/meetup-quest/crews/6/members/18816/info-check",
    body: { action: "request", note: "Which Bundang class are you in?" },
    mutates: true,
    requiresRun: false,
  });
  assert.deepEqual(op(["info", "6", "18816", "--decision", "accept"]).body, { action: "accept", note: "" });
  assert.equal(op(["info", "6", "18816", "--decision", "withdraw"]).body.action, "withdraw");
  assert.throws(() => op(["info", "6", "18816", "--decision", "ask-again"]), /needs --note/);
  assert.throws(() => op(["info", "6", "18816"]), /--decision/);
  assert.throws(() => op(["info", "6"]), /Member user ID/);
});

test("admin meetup set-branch maps staff's branch correction on a member", () => {
  assert.deepEqual(op(["set-branch", "8", "11040", "--branch", "Bundang", "--note", "Old profile comments name Bundang teachers"]), {
    name: "meetup.set-branch",
    method: "POST",
    path: "/cli/admin/meetup-quest/crews/8/members/11040/branch",
    body: { branch: "Bundang", note: "Old profile comments name Bundang teachers" },
    mutates: true,
    requiresRun: false,
  });
  assert.deepEqual(op(["set-branch", "8", "11040", "--branch", "Not a Twinkle student"]).body, {
    branch: "Not a Twinkle student",
    note: "",
  });
  assert.throws(() => op(["set-branch", "8", "11040"]), /needs --branch/);
  assert.throws(() => op(["set-branch", "8", "11040", "--branch", "Bundang", "--branch", "Mapo"]), /exactly one --branch/);
  assert.throws(() => op(["set-branch", "8"]), /Member user ID/);
  assert.throws(() => op(["set-branch", "x", "11040", "--branch", "Bundang"]), /Crew ID/);
  assert.throws(() => op(["set-branch", "8", "11040", "--branch", "Bundang", "--note", "x".repeat(1001)]), /at most 1000/);
  // the receipt keeps ids and the decision, never the private note or the crew
  const receipt = receiptToKeep(
    { name: "meetup.set-branch" },
    {
      ok: true,
      status: "ok",
      changed: true,
      data: {
        result: { crewId: 8, userId: 11040, oldBranch: "Not a Twinkle student", branch: "Bundang", branchStatus: "official", branchVerified: true, changed: true },
        crew: { crewId: 8, status: "active", progress: { currentStep: "crew" }, branchChanges: [{ note: "Old profile comments" }] },
      },
    },
  );
  assert.equal(JSON.stringify(receipt).includes("Old profile"), false);
  assert.equal(receipt.data.result.branch, "Bundang");
  assert.equal(receipt.data.result.branchVerified, true);
});

test("meetup write receipts keep the decision, never the crew view", () => {
  const crew = {
    crewId: 6,
    status: "active",
    progress: { currentStep: "crew" },
    memberChecks: [{ teacherName: "Teacher Jenny", className: "Wed Debate", relationship: "we are friends from camp" }],
    parentContacts: [{ email: "parent@example.test", question: "Is there an adult?" }],
  };
  for (const name of ["meetup.info", "meetup.set-branch", "meetup.emails", "meetup.announce-checkins"]) {
    const receipt = receiptToKeep(
      { name },
      {
        ok: true,
        status: "ok",
        changed: true,
        data: {
          result: { crewId: 6, userId: 18816, status: "requested", changed: true, note: "Which class are you in, Jenny?", attendedUserIds: [3, 4] },
          crew,
          slot: { date: "2026-10-10", start: "10:00", end: "11:00" },
        },
      },
    );
    const text = JSON.stringify(receipt);
    for (const secret of ["Teacher Jenny", "Wed Debate", "camp", "parent@example.test", "adult", "Which class"]) {
      assert.equal(text.includes(secret), false, `${name} receipt keeps "${secret}"`);
    }
    assert.equal(receipt.data.crewId, 6);
    assert.equal(receipt.data.result.status, "requested");
    assert.deepEqual(receipt.data.result.attendedUserIds, [3, 4]);
  }
  const other = { ok: true, data: { x: 1 } };
  assert.equal(receiptToKeep({ name: "teachers.revoke" }, other), other);
});
