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
      fullBatteryUnits: 1200000,
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
      fullBatteryUnits: 1200000,
      user: { id: 42, username: "kim", verified: true },
      poolKey: "manual_bucket:9",
      pools: [
        { poolKey: "manual_bucket:9", current: true, onLedger: true, batteryUnits: 600000, heldUnits: 120000, giveableUnits: 480000, receivedUnits: 600000, receiveRoomUnits: 600000, rechargeUnits: 0 }
      ],
      transfers: [{ id: 88, dayIndex: 1781, direction: "received", units: 600000, fromUserId: 7, toUserId: 42, transactionId: 5 }]
    }
  }).join("\n");
  assert.match(lines, /this account's pool/);
  assert.match(lines, /battery 50% \(600000 units\) · held by running AI calls 120000 · giveable 480000/);
  const reverse = formatBatteryResult({
    operation: op("battery", "reverse", "--transfer", "88", "--reason", "x"),
    data: { dryRun: true, fullBatteryUnits: 1200000, voidedUnits: 480000, alreadySpentUnits: 0, transfers: [{ transferId: 88, fromUserId: 7, toUserId: 42, units: 600000, status: "preview", voidedUnits: 480000, heldUnits: 120000, spentUnits: 0, toQuotaKey: "manual_bucket:9" }] }
  }).join("\n");
  assert.match(reverse, /void 480000, spent 0, 120000 reserved by a running AI call/);
});

test("battery trading on|off is a dry run until --confirm, needs a reason, and warns about the ledger and floor", () => {
  const preview = op("battery", "trading", "on", "--reason", "battery launch");
  assert.equal(preview.name, "battery.trading.preview");
  assert.equal(preview.path, "/cli/admin/battery/trading");
  assert.deepEqual(preview.body, { mode: "on", reason: "battery launch", dryRun: true });
  assert.equal(preview.mutates, false);
  const confirmed = op("battery", "trading", "off", "--reason", "pause", "--confirm");
  assert.equal(confirmed.name, "battery.trading");
  assert.deepEqual(confirmed.body, { mode: "off", reason: "pause", dryRun: false });
  assert.equal(confirmed.mutates, true);
  assert.equal(op("energy", "trading", "on", "--reason", "x").name, "battery.trading.preview");
  assert.throws(() => op("battery", "trading", "maybe", "--reason", "x"), /Pass on or off/);
  assert.throws(() => op("battery", "trading", "on"), /--reason is required/);
  const lines = formatBatteryResult({
    operation: preview,
    data: {
      dryRun: true, changed: true, before: { mode: "off", source: "default" }, after: { mode: "on" },
      ledgerAuthoritativeToday: false, websiteFloor: "2.3.151", batteryWebsiteVersion: "2.6.16",
      websiteFloorCoversBattery: false, effectiveWithinSeconds: 30
    }
  });
  assert.match(lines[0], /Dry run: would turn battery trading on \(was off, the default\)/);
  assert.match(lines.join("\n"), /NOT authoritative today/);
  assert.match(lines.join("\n"), /lumine admin website-floor set 2\.6\.16/);
  assert.match(lines.at(-1), /Add --confirm/);
});

test("website-floor set and clear are audited dry runs until --confirm", async () => {
  const { formatWebsiteFloorResult } = await import("../lib/admin-website-floor.js");
  assert.equal(op("website-floor", "status").path, "/cli/admin/website-floor/status");
  const set = op("website-floor", "set", "2.6.16", "--reason", "battery");
  assert.equal(set.name, "website-floor.set.preview");
  assert.deepEqual(set.body, { version: "2.6.16", reason: "battery", dryRun: true });
  const clear = op("website-floor", "clear", "--reason", "rollback", "--confirm");
  assert.deepEqual(clear.body, { clear: true, reason: "rollback", dryRun: false });
  assert.equal(clear.mutates, true);
  assert.throws(() => op("website-floor", "set", "2.6", "--reason", "x"), /like 2\.6\.16/);
  assert.throws(() => op("website-floor", "set", "2.6.16"), /--reason is required/);
  const lines = formatWebsiteFloorResult({
    operation: set,
    data: { dryRun: true, changed: true, before: { effectiveFloor: "2.3.151", codeFloor: "2.3.151", runtimeFloor: null, source: "default" }, after: { runtimeFloor: "2.6.16" } }
  });
  assert.match(lines[0], /Dry run: would set the runtime floor to 2\.6\.16/);
  assert.match(lines.join("\n"), /already serves 2\.6\.16/);
});
