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

function emptyGatherData(args) {
  const until = Number(args[args.indexOf("--until") + 1]);
  if (args[0] === "reward-diagnostics") return { coverage: "best_effort", since: until - 86400, until, events: [], nextCursor: null };
  if (args[0] === "owner-trace") return { since: Number(args[args.indexOf("--since") + 1]), until, events: [], nextCursor: null, truncated: false };
  if (args[0] === "jev-routing") return { collectionWindow: { since: Number(args[args.indexOf("--since") + 1]), until, includeSynthetic: false }, items: [], nextCursor: null, after: null, hasMore: false, coverage: { scope: "page", status: "exhausted" } };
  if (args[0] === "arena" && args[1] === "paper-queue") return { demandBasis: "waiting-published-papers-v1", entries: [], nextCursor: null };
  if (args[0] === "arena" && args[1] === "today-queue") return { members: [], nextCursor: null };
  return { events: [], truncated: false };
}

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
      const data = args[0] === "bot-output" ? { chatMessages: [], comments: [], pagination: { exhausted: true } }
        : args[0] === "review" ? { filter: "pending", items: [], nextCursor: null }
        : emptyGatherData(args);
      const json = { ok: true, status: "ok", data };
      fs.writeFileSync(outputFile, JSON.stringify(json));
      return { ok: true, attempts: 1, durationMs: 1, json };
    } });
    assert.equal(result.ok, true);
    const end = String(Math.floor(Date.parse(result.data.collection.startedAt) / 1000));
    assert.deepEqual(calls.filter(a => a[0] === "owner-trace"), [
      ["owner-trace", "--since", String(Number(end) - 86400), "--wake", "--limit", "2000", "--until", end],
      ["owner-trace", "--since", String(Number(end) - 30 * 86400), "--type", "session", "--limit", "2000", "--until", end],
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
      const data = args[0] === "bot-output" ? { chatMessages: [], comments: [], pagination: { exhausted: true } }
        : args[0] === "review" ? { filter: "pending", items: [], nextCursor: null }
        : emptyGatherData(args);
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

function detailSample({ height = 669, elapsed = 1000, signals = {}, ...overrides } = {}) {
  const event = sample({
    phase: "interaction", elapsedMs: elapsed,
    window: { width: 390, height }, root: { height },
    visual: { height, offsetTop: 0, scale: 1 },
    nav: { ...sample().data.nav, bottom: height },
    layout: { v: 2, orientation: 0, ancestors: [], body: { top: 0 } },
    activity: { changes: 0, limit: 4, skippedEvents: 0 }, signals, ...overrides,
  });
  event.seq = elapsed; event.clientTime = 1800000000000 + elapsed;
  return event;
}

test("expanded report finds same-page touch boundary changes without calling them confirmed gaps", () => {
  const before = detailSample({ signals: { "first-touch": 1 } });
  const after = detailSample({ height: 777, elapsed: 1300, signals: { "after-first-touch": 1 } });
  const summary = summarizeOwnerViewport({ events: [after, before] }, sessions);
  assert.equal(summary.detail.coverage, "observed");
  assert.equal(summary.detail.firstTouchPairs, 1);
  assert.equal(summary.detail.firstTouchChanges, 1);
  assert.equal(summary.detail.boundaryChanges, 1);
  assert.equal(summary.detail.examples[0].maximum, 108);
  assert.equal(summary.largeGapCycles, 0);
  assert.match(formatOwnerViewportReport(summary), /These are not diagnoses/);
  // A phone clock adjustment must not reverse the same session's touch pair.
  after.clientTime = before.clientTime - 5000;
  assert.equal(summarizeOwnerViewport({ events: [after, before] }, sessions).detail.firstTouchChanges, 1);
});

test("navigation, keyboards, rotation, zoom and stalled touch samples cannot become repair evidence", () => {
  const before = detailSample({ signals: { "first-touch": 1 } });
  for (const override of [
    { focus: { tag: "textarea" } }, { inset: 300 },
    { visual: { height: 777, offsetTop: 0, scale: 2 } },
    { window: { width: 844, height: 777 } },
    { layout: { v: 2, orientation: 90, ancestors: [] } },
    { elapsedMs: undefined },
  ]) {
    const after = detailSample({ height: 777, elapsed: 1300, signals: { "after-first-touch": 1 }, ...override });
    const detail = summarizeOwnerViewport({ events: [before, after] }, sessions).detail;
    assert.equal(detail.firstTouchPairs, 0); assert.equal(detail.boundaryChanges, 0);
  }
  const navigated = detailSample({ height: 777, elapsed: 1300, signals: { "after-first-touch": 1 } });
  navigated.path = "/chat";
  assert.equal(summarizeOwnerViewport({ events: [before, navigated] }, sessions).detail.firstTouchPairs, 0);
  const late = detailSample({ height: 777, elapsed: 6000, signals: { "after-first-touch": 1 } });
  assert.equal(summarizeOwnerViewport({ events: [before, late] }, sessions).detail.firstTouchPairs, 0);
});

test("expanded coverage distinguishes old clients, omitted context, capped activity and unchanged DOM", () => {
  const old = summarizeOwnerViewport({ events: [sample()] }, sessions);
  assert.equal(old.detail.coverage, "unavailable");
  const events = [
    sample(),
    detailSample({ signals: { "first-touch": 1 } }),
    detailSample({ elapsed: 1300, signals: { "after-first-touch": 1 }, activity: { changes: 4, limit: 4 } }),
    detailSample({ elapsed: 2000, layout: { v: 2, omitted: "payload-budget" } }),
  ];
  const summary = summarizeOwnerViewport({ events }, sessions);
  assert.equal(summary.detail.coverage, "partial");
  assert.equal(summary.detail.omittedSamples, 1);
  assert.equal(summary.detail.activityCappedCycles, 1);
  assert.equal(summary.detail.firstTouchPairs, 1);
  assert.equal(summary.detail.firstTouchChanges, 0);
  assert.match(summary.detail.note, /Unchanged DOM measurements cannot rule out/);
});

test("ancestor layout effects and activity signals are retained in the daily report and readable timeline", () => {
  const event = detailSample({ phase: "change", signals: { "window-resize": 3 },
    layout: { v: 2, orientation: 0, ancestors: [{ depth: 1, effects: ["transform"] }], body: { top: -108 } },
  });
  const summary = summarizeOwnerViewport({ events: [event] }, sessions);
  assert.equal(summary.detail.ancestorSamples, 1);
  assert.equal(summary.detail.examples[0].kind, "ancestor-layout-effects");
  const text = formatOwnerTrace({ events: [event] }).join("\n");
  assert.match(text, /window-resize:3/); assert.match(text, /body top -108/);
  assert.match(text, /changes 0\/4/);
});

test("bounded ancestor scans are partial and repeated CSS flags cannot crowd out touch examples", () => {
  const layout = { v: 2, orientation: 0, ancestorLimit: true, ancestors: [{ depth: 1, effects: ["transform"] }] };
  const events = Array.from({ length: 12 }, (_, i) => detailSample({ elapsed: 100 + i * 50, layout }));
  events.push(detailSample({ elapsed: 1000, layout, signals: { "first-touch": 1 } }));
  events.push(detailSample({ elapsed: 1300, height: 777, layout, signals: { "after-first-touch": 1 } }));
  const detail = summarizeOwnerViewport({ events }, sessions).detail;
  assert.equal(detail.coverage, "partial");
  assert.equal(detail.limitedAncestorSamples, 14);
  assert.equal(detail.examples.filter(e => e.kind === "ancestor-layout-effects").length, 3);
  assert.equal(detail.examples.filter(e => e.kind === "first-touch-boundary-change").length, 1);
});

test("late activity cannot stand in for a missing scheduled 20-second observation", () => {
  const late = detailSample({ phase: "change", scheduledMs: 90000, elapsed: 90000 });
  const summary = summarizeOwnerViewport({ events: [late] }, sessions);
  assert.equal(summary.cyclesReaching20s, 0);
  assert.equal(summary.cycles[0].lastScheduledMs, 0);
  const baseline = detailSample({ phase: "settle", scheduledMs: 20000, elapsed: 20005 });
  assert.equal(summarizeOwnerViewport({ events: [baseline, late] }, sessions).cyclesReaching20s, 1);
});

test("daily gather automatically carries new diagnostic evidence into its saved review report", async () => {
  const root = path.resolve("../work/mobile-bottom-gap-20261026/telemetry");
  const dir = fs.mkdtempSync(path.join(root, "gather-test-"));
  const events = [
    detailSample({ signals: { "first-touch": 1 } }),
    detailSample({ height: 777, elapsed: 1300, signals: { "after-first-touch": 1 } }),
  ];
  try {
    await dailyRunGather({ adminOutputDir: dir }, { run(args, { outputFile }) {
      const data = args[0] === "owner-trace" ? { ...emptyGatherData(args), events: (args.includes("--wake") ? events : sessions.events).map((e, i) => ({ ...e, id: i + 1 })) }
        : args[0] === "bot-output" ? { chatMessages: [], comments: [], pagination: { exhausted: true } }
        : args[0] === "review" ? { filter: "pending", items: [], nextCursor: null }
        : emptyGatherData(args);
      const json = { ok: true, status: "ok", data };
      fs.writeFileSync(outputFile, JSON.stringify(json));
      return { ok: true, attempts: 1, durationMs: 1, json };
    } });
    const summary = JSON.parse(fs.readFileSync(path.join(dir, "owner-wake-summary.json"), "utf8"));
    const report = fs.readFileSync(path.join(dir, "owner-wake-summary.md"), "utf8");
    assert.equal(summary.detail.firstTouchChanges, 1);
    assert.match(report, /1 comparable first-touch pairs \(1 changed >=40px\)/);
    assert.match(report, /These are not diagnoses/);
    const review = JSON.parse(fs.readFileSync(path.join(dir, "review-state.json"), "utf8"));
    assert.equal(review.sources.find(s => s.file === "owner-wake-summary.json").read, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a failed session-history fetch keeps expanded daily coverage partial even with fresh inline headers", async () => {
  const dir = fs.mkdtempSync(path.resolve("../work/mobile-bottom-gap-20261026/telemetry/gather-failure-"));
  try {
    await dailyRunGather({ adminOutputDir: dir }, { run(args, { outputFile }) {
      if (args[0] === "owner-trace" && args.includes("session")) return { ok: false, attempts: 1, durationMs: 1, json: { error: { code: "unavailable" } } };
      const data = args[0] === "owner-trace" ? { ...emptyGatherData(args), events: [...sessions.events, detailSample()].map((e, i) => ({ ...e, id: i + 1 })) }
        : args[0] === "bot-output" ? { chatMessages: [], comments: [], pagination: { exhausted: true } }
        : args[0] === "review" ? { filter: "pending", items: [], nextCursor: null }
        : emptyGatherData(args);
      const json = { ok: true, status: "ok", data };
      fs.writeFileSync(outputFile, JSON.stringify(json));
      return { ok: true, attempts: 1, durationMs: 1, json };
    } });
    const summary = JSON.parse(fs.readFileSync(path.join(dir, "owner-wake-summary.json"), "utf8"));
    assert.equal(summary.coverage, "partial");
    assert.equal(summary.detail.coverage, "partial");
    assert.deepEqual(summary.collectionFailures, ["owner-wake-sessions"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
