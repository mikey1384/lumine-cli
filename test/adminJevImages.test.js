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

test("jev-images thumbnails reads advisory notes for targets or the current Featured board", () => {
  const targets = op("jev-images", "thumbnails", "--targets", "subject:12,build:5,subject:12");
  assert.equal(targets.name, "jev-images.thumbnails");
  assert.equal(targets.method, "POST");
  assert.equal(targets.path, "/cli/admin/jev-images/thumbnails");
  assert.deepEqual(targets.body, { targets: ["subject:12", "build:5"] });
  assert.equal(targets.mutates, false);
  assert.equal(targets.requiresRun, false);
  assert.deepEqual(op("jev-images", "thumbnails", "--featured").body, { featured: true });
  assert.deepEqual(op("jev-images", "thumbnails", "--featured", "--saved-only").body, { featured: true, run: false });
  assert.throws(() => op("jev-images", "thumbnails"), /--targets/);
  assert.throws(() => op("jev-images", "thumbnails", "--featured", "--targets", "subject:1"), /not both/);
  assert.throws(() => op("jev-images", "thumbnails", "--targets", "video:3"), /subject:<id> or build:<id>/);
  const many = Array.from({ length: 41 }, (_, i) => `subject:${i + 1}`).join(",");
  assert.throws(() => op("jev-images", "thumbnails", "--targets", many), /1-40/);
  const lines = formatJevImagesResult({
    operation: targets,
    data: {
      status: "partial", flagged: ["build:5"], notice: "Advisory only.",
      items: [
        { target: "build:5", kind: "app", title: "Fight", status: "ok", verdict: "flag", notes: ["mostly empty at card size (fill 0.2/3)"] },
        { target: "subject:12", kind: "post", title: "Link", status: "unavailable", reason: "external_thumbnail" },
      ],
    },
  });
  assert.match(lines[0], /advisory/);
  assert.match(lines[1], /build:5 \(app\) "Fight": LOOK AT THE THUMBNAIL · mostly empty/);
  assert.match(lines[2], /no thumbnail check \(external_thumbnail\)/);
});

test("jev-images switch sets one app's image-decision share only for sdk_decide", () => {
  const app = op("jev-images", "switch", "--area", "sdk_decide", "--build", "91", "--mode", "off");
  assert.deepEqual(app.body, { area: "sdk_decide", mode: "off", buildId: 91 });
  assert.throws(() => op("jev-images", "switch", "--area", "thumbnail", "--build", "91", "--mode", "off"), /sdk_decide/);
  assert.throws(() => op("jev-images", "switch", "--area", "sdk_decide", "--build", "91", "--mode", "on", "--daily-cap", "5"), /no daily cap/);
  assert.match(formatJevImagesResult({ operation: app, data: { area: "sdk_decide", buildId: 91, mode: "off" } })[0], /for build 91: off/);
});

test("featured candidates carry advisory thumbnail notes and stay complete when the check fails", async () => {
  const { featuredThumbnailChecks } = await import("../lib/admin-daily.js");
  const eligible = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const calls = [];
  const result = featuredThumbnailChecks(eligible, (args, opts) => {
    calls.push([args, opts]);
    return { ok: true, json: { data: { status: "partial", flagged: ["subject:1"], notice: "n", items: [
      { target: "subject:1", kind: "app", status: "ok", verdict: "flag", notes: ["x"] },
      { target: "subject:2", status: "unavailable", reason: "no_thumbnail" },
    ] } } };
  });
  assert.deepEqual(calls[0][0], ["jev-images", "thumbnails", "--targets", "subject:1,subject:2,subject:3"]);
  assert.deepEqual(eligible[0].thumbnailCheck, { status: "ok", kind: "app", verdict: "flag", notes: ["x"], cached: false });
  assert.deepEqual(eligible[1].thumbnailCheck, { status: "unavailable", reason: "no_thumbnail" });
  assert.deepEqual(eligible[2].thumbnailCheck, { status: "unavailable", reason: "not_checked" });
  assert.equal(result.summary.advisory, true);
  const failed = [{ id: 4 }];
  const down = featuredThumbnailChecks(failed, () => ({ ok: false, json: null }));
  assert.equal(down.summary.status, "unavailable");
  assert.deepEqual(failed[0].thumbnailCheck, { status: "unavailable", reason: "request_failed" });
  assert.deepEqual(featuredThumbnailChecks([], () => { throw new Error("not called"); }).summary, { status: "none" });
});
