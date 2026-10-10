import assert from "node:assert/strict";
import test from "node:test";

import { meetupAdultLine, parseAdminOperation } from "../lib/admin.js";
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
  assert.deepEqual(op(["approve-plan", "12", "--note", "Have fun"]), {
    name: "meetup.approve-plan",
    method: "POST",
    path: "/cli/admin/meetup-quest/crews/12/approve-plan",
    body: { note: "Have fun" },
    mutates: true,
    requiresRun: false,
  });
  assert.deepEqual(op(["send-back", "12", "--note", "Pick a public place"]).body, {
    note: "Pick a public place",
  });
  assert.deepEqual(op(["approve", "12", "--attended", "3, 4,5,5"]), {
    name: "meetup.approve",
    method: "POST",
    path: "/cli/admin/meetup-quest/crews/12/approve",
    body: { attendedUserIds: [3, 4, 5], note: "" },
    mutates: true,
    requiresRun: false,
  });
});

test("admin meetup refuses incomplete decisions before calling the API", () => {
  assert.throws(() => op(["request-changes", "6"]), /needs --note/);
  assert.throws(() => op(["request-changes", "6", "--note", "x".repeat(1001)]), /at most 1000/);
  assert.throws(() => op(["send-back", "12"]), /needs --note/);
  assert.throws(() => op(["approve", "12"]), /needs --attended/);
  assert.throws(() => op(["approve", "12", "--attended", "3,abc"]), /--attended user ID/);
  assert.throws(() => op(["show", "x"]), /Crew ID/);
  assert.throws(() => op(["list", "--status", "pending"]), /--status must be/);
  assert.throws(() => op(["delete", "12"]), /Usage: lumine admin meetup/);
});

test("shared change requests use their own audited crew endpoint without a daily run", () => {
  assert.deepEqual(op(["request-changes", "6", "--note", "Invite one more current Twinkle student."]), {
    name: "meetup.request-changes",
    method: "POST",
    path: "/cli/admin/meetup-quest/crews/6/request-changes",
    body: { note: "Invite one more current Twinkle student." },
    mutates: true,
    requiresRun: false,
  });
});

test("admin meetup slot and resend-email map to the coordinator fallbacks", () => {
  assert.deepEqual(op(["slot", "12", "--confirm", "1"]), {
    name: "meetup.slot",
    method: "POST",
    path: "/cli/admin/meetup-quest/crews/12/slot",
    body: { slotIndex: 1 },
    mutates: true,
    requiresRun: false,
  });
  assert.equal(op(["slot", "12", "--confirm", "0"]).body.slotIndex, 0);
  assert.throws(() => op(["slot", "12"]), /needs --confirm/);
  assert.equal(op(["resend-email", "12"]).path, "/cli/admin/meetup-quest/crews/12/resend-email");
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
  for (const name of ["meetup.request-changes", "meetup.info", "meetup.set-branch", "meetup.approve-crew", "meetup.approve-plan", "meetup.approve-grownup", "meetup.send-back", "meetup.approve", "meetup.slot", "meetup.parent-reply", "meetup.emails"]) {
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

test("meetup show prints a Twinkle teacher as an approved account (username + id)", () => {
  assert.equal(meetupAdultLine({ kind: "", name: "" }), "");
  assert.equal(meetupAdultLine(undefined), "");
  assert.equal(
    meetupAdultLine({ kind: "parent", name: "Minjun's mom", teacher: null, teacherProblem: "" }),
    "  Adult coming: parent: Minjun's mom",
  );
  assert.equal(
    meetupAdultLine({
      kind: "teacher",
      name: "teacher6",
      teacher: { userId: 179, username: "teacher6", profilePicUrl: "" },
      teacherProblem: "",
    }),
    "  Adult coming: Twinkle teacher teacher6 (user 179, approved teacher account)",
  );
  const teacher = { userId: 179, username: "teacher6", profilePicUrl: "" };
  assert.equal(
    meetupAdultLine({
      kind: "teacher",
      name: "teacher6",
      teacher,
      confirmedAt: 1791417600,
      display: { kind: "teacher", name: "teacher6", status: "confirmed", waitingFor: "" },
    }),
    "  Adult coming: Twinkle teacher teacher6 (user 179, approved teacher account), confirmed 2026-10-08",
  );
  assert.equal(
    meetupAdultLine({
      kind: "teacher",
      name: "",
      teacher,
      confirmedAt: 0,
      teacherProblem: "waiting for the teacher teacher6 to say yes to your request in their chat",
      display: { kind: "teacher", name: "", status: "waiting", waitingFor: "teacher6" },
      request: { status: "open", teacherUserId: 179, teacherUsername: "teacher6", sentAt: 1791417600, answeredAt: 0 },
    }),
    "  Adult coming: Twinkle teacher teacher6 (user 179, approved teacher account), waiting for confirmation (asked 2026-10-08)",
  );
  assert.equal(
    meetupAdultLine({
      kind: "",
      name: "",
      teacher: null,
      display: { kind: "", name: "", status: "", waitingFor: "" },
      request: { status: "declined", teacherUserId: 179, teacherUsername: "teacher6", sentAt: 1, answeredAt: 1791417600 },
    }),
    "  Adult coming: not named yet (Twinkle teacher teacher6 (user 179) declined 2026-10-08)",
  );
  assert.equal(
    meetupAdultLine({
      kind: "",
      name: "",
      request: { status: "declined", afterYes: true, teacherUserId: 179, teacherUsername: "teacher6", answeredAt: 1791417600 },
    }),
    "  Adult coming: not named yet (Twinkle teacher teacher6 (user 179) declined after saying yes 2026-10-08)",
  );
  assert.equal(
    meetupAdultLine({ kind: "", name: "", display: { kind: "classroom", name: "", status: "arranging", waitingFor: "" } }),
    "  Adult coming: classroom meetup, Twinkle arranges the grown-up (slot not confirmed yet)",
  );
  assert.equal(
    meetupAdultLine({
      kind: "",
      name: "",
      display: { kind: "classroom", name: "the Twinkle Mokdong classroom", status: "confirmed", waitingFor: "" },
    }),
    "  Adult coming: classroom meetup, supervised at the Twinkle Mokdong classroom (Twinkle arranges the grown-up)",
  );
  assert.equal(
    meetupAdultLine({
      kind: "teacher",
      name: "",
      unconfirmedName: "Teacher Kim",
      teacher: null,
      teacherProblem: "pick the Twinkle teacher who is coming from the list",
    }),
    '  Adult coming: Twinkle teacher NOT CONFIRMED (on file: "Teacher Kim"): pick the Twinkle teacher who is coming from the list',
  );
  // an older API still sends the typed name as `name`
  assert.match(
    meetupAdultLine({ kind: "teacher", name: "Teacher Kim" }),
    /NOT CONFIRMED \(on file: "Teacher Kim"\): no approved teacher account picked$/,
  );
});
