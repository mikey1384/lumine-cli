import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";
import { formatBatteryResult } from "../lib/admin-battery.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", ...args]));

test("battery inspect is a run-free read", () => {
  const inspect = op("battery", "inspect", "--user", "42", "--days", "7");
  assert.equal(inspect.name, "battery.inspect");
  assert.equal(inspect.method, "GET");
  assert.equal(inspect.path, "/cli/admin/battery/inspect?userId=42&days=7");
  assert.equal(inspect.mutates, false);
  assert.equal(inspect.requiresRun, false);
  assert.throws(() => op("battery", "inspect", "--days", "20", "--user", "42"), /--days is 1 to 14/);
});

test("battery hold and unhold are dry runs until --confirm and need a reason", () => {
  const preview = op("battery", "hold", "42", "--reason", "feeder under review");
  assert.equal(preview.name, "battery.hold.preview");
  assert.deepEqual(preview.body, { userId: 42, reason: "feeder under review", dryRun: true });
  assert.equal(preview.mutates, false);
  const confirmed = op("battery", "unhold", "42", "--reason", "siblings", "--confirm");
  assert.equal(confirmed.name, "battery.unhold");
  assert.equal(confirmed.path, "/cli/admin/battery/unhold");
  assert.equal(confirmed.body.dryRun, false);
  assert.equal(confirmed.mutates, true);
  assert.throws(() => op("battery", "hold", "42"), /--reason is required/);
});

test("battery reverse takes transfer ids and reports that the sender gets nothing back", () => {
  const preview = op("battery", "reverse", "--transfer", "88,89", "--reason", "alt funnel");
  assert.deepEqual(preview.body, { transferIds: [88, 89], reason: "alt funnel", dryRun: true });
  assert.throws(() => op("battery", "reverse", "--reason", "x"), /--transfer/);
  const lines = formatBatteryResult({
    operation: preview,
    data: {
      dryRun: true,
      voidedUnits: 300000,
      alreadySpentUnits: 300000,
      transfers: [{ transferId: 88, fromUserId: 1, toUserId: 2, units: 600000, status: "preview", voidedUnits: 300000, spentUnits: 300000 }]
    }
  }).join("\n");
  assert.match(lines, /would void 300000 units \(25%\)/);
  assert.match(lines, /sender gets nothing back/);
  assert.match(lines, /Add --confirm/);
});

test("battery output names the pool, in-flight holds and reserved units", () => {
  const inspect = op("battery", "inspect", "--user", "42");
  const lines = formatBatteryResult({
    operation: inspect,
    data: {
      user: { id: 42, username: "kim", verified: true },
      poolKey: "manual_bucket:9",
      pools: [
        { poolKey: "manual_bucket:9", current: true, onLedger: true, batteryUnits: 600000, heldUnits: 120000, giveableUnits: 480000, receivedUnits: 600000, receiveRoomUnits: 600000, rechargeUnits: 0 }
      ],
      transfers: [{ id: 88, dayIndex: 1781, direction: "received", units: 600000, fromUserId: 7, toUserId: 42, transactionId: 5 }]
    }
  }).join("\n");
  assert.match(lines, /this account's pool/);
  assert.match(lines, /held by running AI calls 120000 · giveable 480000/);
  const reverse = formatBatteryResult({
    operation: op("battery", "reverse", "--transfer", "88", "--reason", "x"),
    data: { dryRun: true, voidedUnits: 480000, alreadySpentUnits: 0, transfers: [{ transferId: 88, fromUserId: 7, toUserId: 42, units: 600000, status: "preview", voidedUnits: 480000, heldUnits: 120000, spentUnits: 0, toQuotaKey: "manual_bucket:9" }] }
  }).join("\n");
  assert.match(reverse, /void 480000, spent 0, 120000 reserved by a running AI call/);
});
