import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";
import { formatJevImagesResult } from "../lib/admin-jev-images.js";
import { formatArenaResult } from "../lib/admin-arena.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", ...args]));

test("jev-images report is a run-free read with a bounded window", () => {
  const report = op("jev-images", "report", "--days", "7");
  assert.equal(report.name, "jev-images.report");
  assert.equal(report.method, "GET");
  assert.equal(report.path, "/cli/admin/jev-images/report?days=7");
  assert.equal(report.mutates, false);
  assert.equal(report.requiresRun, false);
  assert.equal(op("jev-images", "report").path, "/cli/admin/jev-images/report?days=1");
  assert.throws(() => op("jev-images", "report", "--days", "31"), /--days/);
});

test("jev-images switch and decide validate their inputs", () => {
  const off = op("jev-images", "switch", "--area", "all", "--mode", "off");
  assert.deepEqual(off.body, { area: "all", mode: "off" });
  assert.equal(off.mutates, true);
  const capped = op("jev-images", "switch", "--area", "arena_picture", "--mode", "on", "--daily-cap", "50");
  assert.deepEqual(capped.body, { area: "arena_picture", mode: "on", dailyCap: 50 });
  assert.throws(() => op("jev-images", "switch", "--area", "all", "--mode", "on", "--daily-cap", "5"), /per area/);
  assert.throws(() => op("jev-images", "switch", "--area", "everything", "--mode", "on"), /Usage/);
  const decide = op("jev-images", "decide", "--area", "arena_picture", "--key", "arenaItem:10176", "--decision", "keep");
  assert.deepEqual(decide.body, { area: "arena_picture", subjectKey: "arenaItem:10176", decision: "keep" });
  assert.throws(() => op("jev-images", "decide", "--area", "arena_picture", "--key", "10176", "--decision", "keep"), /--key/);
});

test("arena picture-audit sends renders for the named items and never mutates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-renders-"));
  try {
    fs.writeFileSync(path.join(dir, "9643.png"), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(dir, "9999.png"), Buffer.from([4]));
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    const audit = op("arena", "picture-audit", "--items", "9643,10176", "--renders", dir);
    assert.equal(audit.name, "arena.picture-audit");
    assert.equal(audit.mutates, false);
    assert.equal(audit.requiresRun, false);
    assert.deepEqual(audit.body.itemIds, [9643, 10176]);
    assert.deepEqual(Object.keys(audit.body.renders), ["9643"]);
    assert.equal(audit.body.renders["9643"], Buffer.from([1, 2, 3]).toString("base64"));
    const paged = op("arena", "picture-audit", "--cursor", "100", "--limit", "5");
    assert.deepEqual(paged.body, { limit: 5, cursor: 100 });
    assert.throws(() => op("arena", "picture-audit", "--limit", "21"), /--limit/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report and audit output name escalations, disagreements and review items", () => {
  const lines = formatJevImagesResult({
    operation: { name: "jev-images.report" },
    data: {
      model: "jev-1.13.0", window: { days: 1 }, coverage: { status: "complete" }, totals: { checks: 3, costUsd: 0.0004 },
      areas: { arena_paper: { setting: { mode: "on", source: "default", dailyCap: 300, usedToday: 3 }, checks: 3, ok: 2, errors: 1, timeouts: 1, droppedRetries: 0, latencyMs: { p95: 4000 }, tokens: { input: 9000 }, costUsd: 0.0004, agreementRate: 0.5, agreed: 1, scored: 2, flaggedUndecided: 0, disagreements: [{ eventId: 4, subjectKey: "arenaPaper:2:p1", advisory: "flag", finalDecision: "approved" }] } },
      escalations: [{ area: "arena_paper", code: "error_rate", detail: "1/3 sent checks failed" }],
    },
  });
  assert.ok(lines.some((line) => line.includes("disagreement #4 arenaPaper:2:p1")));
  assert.ok(lines.some((line) => line.includes("arena_paper error_rate")));
  const audit = formatArenaResult({
    operation: { name: "arena.picture-audit" },
    data: { items: [{ itemId: 1, examFamily: "suneung-eng", itemType: "eng.l.picture", kind: "picture_mismatch", status: "audited", verdict: "flag", notes: ["stray text"] }, { itemId: 2, examFamily: "tosel-ba", itemType: "tosel.l.recognize", kind: "picture_options", status: "needs_render", reason: "x" }], review: [{}], needsRender: [2], nextCursor: null, notice: "Advisory" },
  });
  assert.ok(audit[0].includes("1 to review"));
  assert.ok(audit.some((line) => line.includes("#1") && line.includes("REVIEW")));
  assert.ok(audit.some((line) => line.includes("needs_render")));
});
