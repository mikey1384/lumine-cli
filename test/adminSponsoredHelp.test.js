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

test("sponsored-help switch sends only on, owner or off and needs no run", () => {
  const on = op("sponsored-help", "switch", "--mode", "on");
  assert.equal(on.path, "/cli/admin/sponsored-help/switch");
  assert.deepEqual(on.body, { mode: "on" });
  assert.equal(on.mutates, true);
  assert.equal(on.requiresRun, false);
  assert.throws(() => op("sponsored-help", "switch"), /--mode is on, owner or off/);
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

test("sponsored-help welcome show, set and switch", () => {
  const show = op("sponsored-help", "welcome");
  assert.equal(show.name, "sponsored-help.welcome.show");
  assert.equal(show.path, "/cli/admin/sponsored-help/welcome");
  assert.equal(show.mutates, false);
  const set = op("sponsored-help", "welcome", "set", "--audience", "teacher", "--bot", "ciel", "--task", "Open my classes", "--percent", "15", "--holdout", "20");
  assert.equal(set.method, "POST");
  assert.deepEqual(set.body, { audience: "teacher", persona: "ciel", task: "Open my classes", percent: 15, holdoutPercent: 20 });
  assert.throws(() => op("sponsored-help", "welcome", "set", "--bot", "zero", "--task", "x y z"), /--audience/);
  assert.throws(() => op("sponsored-help", "welcome", "set", "--audience", "student", "--bot", "lumine", "--task", "x y z"), /--bot/);
  assert.throws(() => op("sponsored-help", "welcome", "set", "--audience", "student", "--bot", "zero"), /--task/);
  assert.throws(() => op("sponsored-help", "welcome", "set", "--audience", "student", "--bot", "zero", "--task", "abc", "--holdout", "95"), /--holdout/);
  const sw = op("sponsored-help", "welcome", "switch", "--mode", "on");
  assert.equal(sw.path, "/cli/admin/sponsored-help/welcome/switch");
  assert.deepEqual(sw.body, { mode: "on" });
});

test("an unset welcome says new accounts get the plain greeting", () => {
  const lines = formatSponsoredHelpResult({
    operation: { name: "sponsored-help.welcome.show" },
    data: { sponsoredHelpSwitch: "on", welcomeSwitch: "on", audiences: [{ audience: "student", configured: false }] }
  });
  assert.match(lines.join("\n"), /student: no task set/);
});

test("sponsored-help switches accept owner, and welcome preview takes a user and audience", () => {
  assert.deepEqual(op("sponsored-help", "switch", "--mode", "owner").body, { mode: "owner" });
  assert.deepEqual(op("sponsored-help", "welcome", "switch", "--mode", "owner").body, { mode: "owner" });
  const preview = op("sponsored-help", "welcome", "preview", "--user", "mikey", "--audience", "teacher");
  assert.equal(preview.path, "/cli/admin/sponsored-help/welcome/preview");
  assert.deepEqual(preview.body, { user: "mikey", audience: "teacher" });
  assert.equal(preview.requiresRun, false);
  assert.throws(() => op("sponsored-help", "welcome", "preview", "--audience", "student"), /--user/);
  assert.throws(() => op("sponsored-help", "welcome", "preview", "--user", "mikey"), /--audience/);
  const lines = formatSponsoredHelpResult({
    operation: { name: "sponsored-help.welcome.preview" },
    data: { audience: "student", username: "mikey", userId: 5, persona: "zero", task: "Make my first game", requestId: 9, pathId: 123 }
  });
  assert.match(lines.join("\n"), /TEST student welcome to mikey/);
});

test("the status report prints wand outcomes: per task success, top failures, open card slots", () => {
  const lines = formatSponsoredHelpResult({
    operation: { name: "sponsored-help.status" },
    data: {
      switch: "on",
      fromDay: 100,
      events: [],
      outcomes: {
        tasks: [
          { task: "app_address", presses: 5, done: 2, failed: 1, abandoned: 1, notAvailable: 1, successRate: 0.67, spentUnits: 50000 },
          { task: "chat_session", presses: 1, done: 0, failed: 0, abandoned: 1, notAvailable: 0, successRate: null, spentUnits: 900 }
        ],
        topFailures: [{ task: "app_address", code: "app_not_yours", count: 1 }],
        stepFailures: [{ step: "action:open_app_address failed:app_not_yours", count: 1 }],
        openCards: [{ openCardId: 7, senderId: 5, taskKind: "app_address", used: 3, cap: 20, done: 2, spentUnits: 40000, closed: false }]
      }
    }
  });
  const text = lines.join("\n");
  assert.match(text, /app_address: 5 pressed, 2 done, 1 failed, 1 abandoned, 1 not available · success 67%/);
  assert.match(text, /chat_session: .* success n\/a/);
  assert.match(text, /top failures: app_address:app_not_yours 1/);
  assert.match(text, /failed steps: action:open_app_address failed:app_not_yours 1/);
  assert.match(text, /open card 7 \(sender 5, app_address\): 3\/20 used, 2 done/);
  // an API from before the outcome record prints nothing new
  const old = formatSponsoredHelpResult({ operation: { name: "sponsored-help.status" }, data: { switch: "on", fromDay: 1, events: [] } });
  assert.doesNotMatch(old.join("\n"), /Wand outcomes/);
});
