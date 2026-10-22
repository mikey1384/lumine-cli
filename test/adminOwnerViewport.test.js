import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { summarizeOwnerViewport, formatOwnerViewportReport } from "../lib/admin-owner-viewport.js";
import { formatOwnerTrace } from "../lib/admin-owner-trace.js";
import { dailyRunGather } from "../lib/admin-daily.js";

function sample(overrides = {}) {
  return { type: "wake-viewport", sessionId: "phone-session", seq: 8, clientTime: 1800000001000, path: "/", data: {
    v: 1, version: "test", cycle: 1, phase: "settle", scheduledMs: 1000, elapsedMs: 1005, visibility: "visible",
    window: { height: 800 }, root: { height: 800 }, visual: { height: 800, offsetTop: 0, scale: 1 },
    nav: { position: "fixed", bottomStyle: "0px", bottom: 565, height: 55, display: "flex", visibility: "visible", transform: "none" },
    focus: { tag: "body", editable: false }, inset: 0, ...overrides,
  } };
}
const sessions = { events: [{ type: "session", sessionId: "phone-session", data: { version: "test", platform: "iPhone", ua: "test Safari" } }] };

test("reports repeated settled displacement separately from missing coverage", () => {
  const summary = summarizeOwnerViewport({ since: 123, events: [sample(), sample({ scheduledMs: 3000, elapsedMs: 3005 }), sample({ phase: "background" })] }, sessions);
  assert.equal(summary.coverage, "observed");
  assert.equal(summary.largeGapCycles, 1); assert.equal(summary.repeatedLargeGapCycles, 1);
  assert.equal(summary.cycles[0].maxRootGap, 235);
  assert.equal(summary.cycles[0].platform, "iPhone");
  assert.match(formatOwnerViewportReport(summary), /investigation lead, not a proven defect/);
  assert.equal(summarizeOwnerViewport({ events: [] }).coverage, "unavailable");
  assert.equal(summarizeOwnerViewport({ events: [sample()] }).coverage, "partial");
});

test("normal wakes, keyboard, zoom, hidden nav and transient startup do not become floating-nav candidates", () => {
  const base = sample().data;
  for (const change of [
    { nav: { ...base.nav, bottom: 800 } },
    { focus: { tag: "textarea", editable: false } },
    { visual: { ...base.visual, scale: 1.5 } },
    { inset: 235 }, { nav: null }, { nav: { ...base.nav, display: "none" } },
    { phase: "start", scheduledMs: 0 }, { visibility: "hidden" },
  ]) assert.equal(summarizeOwnerViewport({ events: [sample(change)] }, sessions).largeGapCycles, 0);
  const healthy = summarizeOwnerViewport({ events: [sample({ nav: { ...base.nav, bottom: 800 } })] }, sessions);
  assert.equal(healthy.cycles.length, 1); assert.equal(healthy.coverage, "observed");
});

test("short layout viewport still exposes the visual gap and malformed evidence never looks healthy", () => {
  const summary = summarizeOwnerViewport({ events: [sample({ root: { height: 565 } })] }, sessions);
  assert.equal(summary.cycles[0].maxRootGap, 0); assert.equal(summary.cycles[0].maxVisualGap, 235);
  const incomplete = summarizeOwnerViewport({ truncated: true, events: [
    sample({ _trimmed: ["nav"], nav: "[cut 300 chars]" }),
    { type: "trace-dropped", data: { count: 4 } },
    sample({ error: "geometry-unavailable" }),
  ] }, sessions);
  assert.equal(incomplete.coverage, "unavailable"); assert.equal(incomplete.unavailableSamples, 2);
  assert.equal(incomplete.droppedEvents, 4); assert.equal(incomplete.largeGapCycles, 0);
});

test("desktop top navigation is not a floating bottom-nav candidate", () => {
  const nav = { ...sample().data.nav, bottom: 45, bottomStyle: "755px" };
  for (const bottomStyle of ["auto", "755px", undefined]) {
    const summary = summarizeOwnerViewport({ events: [sample({ nav: { ...nav, bottomStyle } })] }, sessions);
    assert.equal(summary.largeGapCycles, 0);
  }
});

test("queued timers released together do not establish repeated displacement", () => {
  const events = [sample({ scheduledMs: 1000, elapsedMs: 3500 }), sample({ scheduledMs: 3000, elapsedMs: 3502 })];
  assert.equal(summarizeOwnerViewport({ events }, sessions).repeatedLargeGapCycles, 0);
  events.push(sample({ scheduledMs: 20000, elapsedMs: 20005 }));
  assert.equal(summarizeOwnerViewport({ events }, sessions).repeatedLargeGapCycles, 1);
});

test("one client's geometry cannot conceal missing measurements from another client", () => {
  const other = { type: "session", sessionId: "other-phone", data: { version: "test", platform: "iPhone", viewportTrace: 1 } };
  const summary = summarizeOwnerViewport({ events: [sample(), other] }, sessions);
  assert.equal(summary.coverage, "partial");
  assert.equal(summary.clientsWithoutGeometry, 1);
  assert.equal(summary.clients.find(c => c.sessionId === "other-phone").viewportSupport, true);
  assert.match(formatOwnerViewportReport(summary), /clients without usable geometry: 1/);
});

test("readable owner timeline includes geometry and survives server trimming", () => {
  const text = formatOwnerTrace({ events: [sample(), sample({ nav: "[cut 300 chars]", _trimmed: ["nav"] })] }).join("\n");
  assert.match(text, /nav bottom 565/); assert.match(text, /visual 800 top 0 scale 1/);
  assert.match(text, /trimmed/);
});

test("daily gather collects wake/session evidence and creates an explicit report even before rollout", async () => {
  const root = path.resolve("../work/owner-wake-viewport-20261022");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "gather-test-"));
  const calls = [];
  try {
    const result = await dailyRunGather({ adminOutputDir: dir }, { run(args, { outputFile }) {
      calls.push(args);
      const data = args[0] === "bot-output" ? { pagination: { exhausted: true } } : { events: [], truncated: false };
      const json = { ok: true, status: "ok", data };
      fs.writeFileSync(outputFile, JSON.stringify(json));
      return { ok: true, attempts: 1, durationMs: 1, json };
    } });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.filter(a => a[0] === "owner-trace"), [
      ["owner-trace", "--since", "24h", "--wake", "--limit", "2000"],
      ["owner-trace", "--since", "30d", "--type", "session", "--limit", "2000"],
    ]);
    assert.equal(result.data.ownerWake.coverage, "unavailable");
    const report = fs.readFileSync(path.join(dir, "owner-wake-summary.md"), "utf8");
    assert.match(report, /Coverage: \*\*unavailable\*\*/);
    const review = JSON.parse(fs.readFileSync(path.join(dir, "review-state.json"), "utf8"));
    assert.equal(review.sources.find(s => s.file === "owner-wake-summary.json").read, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("failed wake collection is explicit and cannot reuse a previous run's successful file", async () => {
  const root = path.resolve("../work/owner-wake-viewport-20261022");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "gather-failure-test-"));
  try {
    fs.writeFileSync(path.join(dir, "owner-wake.json"), JSON.stringify({ ok: true, data: { events: [sample()] } }));
    const result = await dailyRunGather({ adminOutputDir: dir }, { run(args, { outputFile }) {
      if (args[0] === "owner-trace" && args.includes("--wake")) return { ok: false, attempts: 1, durationMs: 1, json: { error: { code: "unavailable" } } };
      const data = args[0] === "bot-output" ? { pagination: { exhausted: true } } : { events: [], truncated: false };
      const json = { ok: true, status: "ok", data };
      fs.writeFileSync(outputFile, JSON.stringify(json));
      return { ok: true, attempts: 1, durationMs: 1, json };
    } });
    assert.equal(result.ok, false);
    assert.ok(result.data.failed.includes("owner-wake"));
    const summary = JSON.parse(fs.readFileSync(path.join(dir, "owner-wake-summary.json"), "utf8"));
    assert.equal(summary.coverage, "unavailable"); assert.equal(summary.viewportEvents, 0);
    assert.deepEqual(summary.collectionFailures, ["owner-wake"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
