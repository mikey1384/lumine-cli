import assert from "node:assert/strict";
import test from "node:test";

import { parseAdminOperation } from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";

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
  assert.throws(() => op(["send-back", "12"]), /needs --note/);
  assert.throws(() => op(["approve", "12"]), /needs --attended/);
  assert.throws(() => op(["approve", "12", "--attended", "3,abc"]), /--attended user ID/);
  assert.throws(() => op(["show", "x"]), /Crew ID/);
  assert.throws(() => op(["list", "--status", "pending"]), /--status must be/);
  assert.throws(() => op(["delete", "12"]), /Usage: lumine admin meetup/);
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
