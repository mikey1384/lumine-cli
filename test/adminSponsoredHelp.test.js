import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";
import { formatSponsoredHelpResult } from "../lib/admin-sponsored-help.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", ...args]));

test("sponsored-help status is a run-free read with a bounded day span", () => {
  const status = op("sponsored-help", "status", "--days", "3");
  assert.equal(status.name, "sponsored-help.status");
  assert.equal(status.method, "GET");
  assert.equal(status.path, "/cli/admin/sponsored-help/status?days=3");
  assert.equal(status.requiresRun, false);
  assert.equal(op("sponsored-help").path, "/cli/admin/sponsored-help/status?days=1");
  assert.throws(() => op("sponsored-help", "status", "--days", "40"), /--days/);
});

test("sponsored-help switch sends only on or off and needs no run", () => {
  const on = op("sponsored-help", "switch", "--mode", "on");
  assert.equal(on.path, "/cli/admin/sponsored-help/switch");
  assert.deepEqual(on.body, { mode: "on" });
  assert.equal(on.mutates, true);
  assert.equal(on.requiresRun, false);
  assert.throws(() => op("sponsored-help", "switch"), /--mode is on or off/);
});

test("the status report prints per-day events with refunded units", () => {
  const lines = formatSponsoredHelpResult({
    operation: { name: "sponsored-help.status" },
    data: {
      switch: "on",
      fromDay: 100,
      events: [
        { dayIndex: 100, event: "sent", count: 4, units: 0 },
        { dayIndex: 100, event: "refunded", count: 2, units: 90000 }
      ],
      refusals: [{ reason: "daily_limit", count: 1 }],
      senders: [{ senderId: 5, sent: 4, recipients: 3, spentUnits: 30000, declined: 1 }]
    }
  });
  assert.match(lines.join("\n"), /day 100: sent 4, refunded 2 \(90000 units\)/);
  assert.match(lines.join("\n"), /refused: daily_limit 1/);
});
