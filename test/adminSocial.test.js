import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";
import { formatSocialResult } from "../lib/admin-social.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", ...args]));

test("social report is a run-free read with a bounded window and an optional build", () => {
  const report = op("social", "report", "--days", "7", "--json");
  assert.equal(report.name, "social.report");
  assert.equal(report.method, "GET");
  assert.equal(report.path, "/cli/admin/social/report?days=7");
  assert.equal(report.mutates, false);
  assert.equal(report.requiresRun, false);
  assert.equal(op("social", "report").path, "/cli/admin/social/report?days=1");
  assert.equal(op("social").path, "/cli/admin/social/report?days=1");
  assert.equal(op("social", "report", "--build", "2809", "--days", "3").path, "/cli/admin/social/report?days=3&buildId=2809");
  assert.throws(() => op("social", "report", "--days", "31"), /--days/);
  assert.throws(() => op("social", "report", "--days", "0"), /--days/);
  assert.throws(() => op("social", "report", "--build", "abc"), /--build/);
  assert.throws(() => op("social", "reset"), /Usage: lumine admin social report/);
});

test("the text output headlines the last completed day, keeps today apart and lists flags", () => {
  const lines = formatSocialResult({
    data: {
      status: "ok",
      store: "valkey",
      buildId: null,
      ttlDays: 35,
      window: { days: 7, from: "2026-11-15", lastCompletedDay: "2026-11-21", inProgressDay: "2026-11-22" },
      lastCompletedDay: {
        day: "2026-11-21",
        status: "measured",
        partial: true,
        firstCountAt: "2026-11-21T08:00:00.000Z",
        counters: { "dropin.refused.room_busy_no_key": 11, "walkup.refused.blocked": 1 },
        headline: { joinTaps: 14, dropIns: 3, matchReadyAcks: 0, refusals: 12 },
      },
      trailing: { days: 6, measuredDays: 2, partialDays: 1, counters: {}, dailyAverage: { "dropin.ok": 2 } },
      writer: { state: "denied", consecutiveFailures: 4, lastFailure: "denied" },
      inProgressDay: { day: "2026-11-22", status: "absent", counters: {}, headline: {} },
      topBuilds: [{ buildId: 2809, dropIns: 5, walkupsQueued: 0, joinTaps: 9, matchReadyAcks: 2, togetherOk: 1, notices: 1, openEvents: 4 }],
      flags: [{ code: "dropins_without_match_ready", scope: "lastCompletedDay", detail: "3 drop-ins, 0 acks." }],
      notes: ["1 trailing day(s) not measured"],
    },
  });
  const text = lines.join("\n");
  assert.match(text, /Last completed day 2026-11-21 \(measured, partial from 2026-11-21T08:00:00.000Z\): 14 Join taps/);
  assert.match(text, /3 drop-ins/);
  assert.match(text, /dropin room_busy_no_key 11, walkup blocked 1/);
  assert.match(text, /Trailing 6 day\(s\), 2 measured \(1 partial, left out of the average\), daily average: 0 Join taps, 2 drop-ins/);
  assert.match(text, /Counter writes on this API process: DENIED by Valkey \(4 flushes in a row\)/);
  assert.match(text, /In progress 2026-11-22 \(absent\): not measured/);
  assert.match(text, /#2809: 5 drop-ins/);
  assert.match(text, /dropins_without_match_ready \(lastCompletedDay\)/);
});

test("unavailable telemetry is never shown as zeros", () => {
  const lines = formatSocialResult({ data: { status: "unavailable", reason: "no_store", detail: "No walk-up store.", writer: { state: "idle" } } });
  assert.match(lines[0], /UNAVAILABLE \(no_store\)/);
  assert.match(lines.join("\n"), /not .*zero traffic/);
  assert.doesNotMatch(lines.join("\n"), /0 drop-ins/);
});

test("daily gather saves the social report and the admin guide carries the duty", () => {
  const daily = fs.readFileSync(new URL("../lib/admin-daily.js", import.meta.url), "utf8");
  assert.match(daily, /step\("social", \["social", "report", "--days", "7"\], "social\.json"\)/);
  const guide = fs.readFileSync(new URL("../sdk/LUMINE_ADMIN.md", import.meta.url), "utf8");
  assert.match(guide, /lumine admin social report --days 7 --json/);
  assert.match(guide, /Absent data is not zero traffic/);
  assert.match(guide, /telemetry_writes_denied/);
  assert.match(guide, /partial/);
});
