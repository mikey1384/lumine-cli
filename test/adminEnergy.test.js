import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";
import { formatEnergyResult } from "../lib/admin-energy.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", ...args]));

test("energy reset is a dry run until --confirm and needs a scope and a reason", () => {
  const preview = op("energy", "reset", "--all", "--reason", "outage on 11-22");
  assert.equal(preview.name, "energy.reset.preview");
  assert.equal(preview.path, "/cli/admin/energy/reset");
  assert.deepEqual(preview.body, { all: true, reason: "outage on 11-22", dryRun: true });
  assert.equal(preview.mutates, false);
  assert.equal(preview.requiresRun, false);
  const confirmed = op("energy", "reset", "--user", "42", "--reason", "gift", "--confirm");
  assert.equal(confirmed.name, "energy.reset");
  assert.deepEqual(confirmed.body, { userId: 42, reason: "gift", dryRun: false });
  assert.equal(confirmed.mutates, true);
  assert.throws(() => op("energy", "reset", "--all"), /--reason is required/);
  assert.throws(() => op("energy", "reset", "--reason", "x"), /exactly one of --all or --user/);
  assert.throws(() => op("energy", "reset", "--all", "--user", "42", "--reason", "x"), /exactly one/);
});

test("energy reset output says recharges are untouched", () => {
  const lines = formatEnergyResult({
    data: { dryRun: true, scope: "all", poolsReset: 3, refilledUnits: 1800000, fullBatteryUnits: 1200000 }
  });
  assert.match(lines[0], /Dry run: would reset today's AI battery for everyone: 3 pools/);
  assert.match(lines[0], /Recharges were not touched/);
  assert.match(lines[1], /--confirm/);
});
