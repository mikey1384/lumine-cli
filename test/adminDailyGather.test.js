import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { dailyRunGather, runAdmin } from "../lib/admin-daily.js";
import { summarizeDailyProgress } from "../lib/admin-duties.js";
import { testWorkRoot } from "./helpers/work-directory.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(testWorkRoot(), "build-review-gather-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const page = (items = [], nextCursor = null) => ({ filter: "pending", items, nextCursor });
const read = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));

function runner(reviewPage) {
  const calls = [];
  return {
    calls,
    run(args, { outputFile, retryRead }) {
      calls.push(args);
      assert.equal(retryRead, true);
      const data = args[0] === "review" ? reviewPage(args)
        : args[0] === "bot-output" ? { chatMessages: [], comments: [], pagination: { exhausted: true } }
        : args[0] === "arena" && args[1] === "today-queue" ? { members: [], nextCursor: null }
        : { events: [], truncated: false };
      if (data instanceof Error) {
        // Failed children may leave an earlier successful receipt in place.
        return { ok: false, attempts: 1, durationMs: 1, json: { error: { code: data.message } } };
      }
      const json = { ok: true, status: "ok", data };
      fs.writeFileSync(outputFile, JSON.stringify(json));
      return { ok: true, attempts: 1, durationMs: 1, json };
    },
  };
}

test("gather exhausts one unified pending queue for all Build types without a rewards-only duplicate", async (t) => {
  const dir = fixture(t);
  const items = ["rewards", "project-limit", "storage-limit", "cardcraft", "soundtrack"]
    .map((type, id) => ({ type, id: id + 1 }));
  const stub = runner(args => args.includes("--cursor") ? page(items.slice(3)) : page(items.slice(0, 3), "1700000000.2.3"));
  const result = await dailyRunGather({ adminOutputDir: dir }, stub);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.buildReviews, { complete: true, pages: 2, items: 5 });
  assert.deepEqual(stub.calls.filter(args => args[0] === "review"), [
    ["review", "list", "--status", "pending"],
    ["review", "list", "--status", "pending", "--cursor", "1700000000.2.3"],
  ]);
  assert.ok(!stub.calls.some(args => args[0] === "reward-review"));
  assert.ok(stub.calls.some(args => args[0] === "approvals")); // Different management queue stays.
  const sources = read(dir, "review-state.json").sources.filter(source => source.file.startsWith("build-reviews-"));
  assert.equal(sources.length, 2);
  assert.ok(sources.every(source => source.fetched && source.sha256 && !source.read));
  assert.deepEqual(read(dir, "build-reviews-2.json").data.items, items.slice(3));
});

test("an explicitly exhausted empty queue replaces old page duties but preserves their files", async (t) => {
  const dir = fixture(t);
  const oldFiles = ["rr-pending.json", "build-reviews-2.json", "arena-today-queue-2.json", "bot-output-2.json", "manual-evidence.json"];
  for (const file of oldFiles) fs.writeFileSync(path.join(dir, file), "{}");
  fs.writeFileSync(path.join(dir, "review-state.json"), JSON.stringify({
    protocol: 1, sources: oldFiles.map(file => ({ file, fetched: true, read: true })),
  }));
  const result = await dailyRunGather({ adminOutputDir: dir }, runner(() => page()));
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.buildReviews, { complete: true, pages: 1, items: 0 });
  const sources = read(dir, "review-state.json").sources;
  assert.ok(!sources.some(source => oldFiles.slice(0, -1).includes(source.file)));
  assert.deepEqual(result.data.personalQueue, { complete: true, pages: 1, members: 0 });
  assert.equal(sources.find(source => source.file === "manual-evidence.json").retained, true);
  assert.ok(oldFiles.every(file => fs.existsSync(path.join(dir, file))));
});

test("a failed later page cannot reuse a previous success or stop unrelated daily collection", async (t) => {
  const dir = fixture(t);
  await dailyRunGather({ adminOutputDir: dir }, runner(args => args.includes("--cursor") ? page([{ id: 2 }]) : page([{ id: 1 }], "100")));
  const stub = runner(args => args.includes("--cursor") ? new Error("unavailable") : page([{ id: 1 }], "100"));
  const result = await dailyRunGather({ adminOutputDir: dir }, stub);
  assert.equal(result.status, "partial_failure");
  assert.deepEqual(result.data.buildReviews, { complete: false, pages: 2, items: 1 });
  assert.deepEqual(result.data.failed, ["build-reviews-page-2"]);
  const source = read(dir, "review-state.json").sources.find(s => s.file === "build-reviews-2.json");
  assert.equal(source.fetched, false);
  assert.equal(source.read, false);
  assert.equal(source.sha256, undefined);
  assert.equal(read(dir, "build-reviews-2.json").ok, true); // Old bytes are not proof of success.
  assert.ok(stub.calls.some(args => args[0] === "bot-output"));
});

test("missing or malformed page data never becomes a healthy empty queue", async (t) => {
  for (const data of [undefined, {}, { ...page(), items: null }, { ...page(), nextCursor: undefined },
    { ...page(), nextCursor: "" }, { ...page(), nextCursor: "invalid" }, { ...page(), filter: "queue" }]) {
    const dir = fixture(t);
    const result = await dailyRunGather({ adminOutputDir: dir }, runner(() => data));
    assert.equal(result.status, "partial_failure");
    assert.equal(result.data.buildReviews.complete, false);
    assert.deepEqual(result.data.failed, ["build-reviews-page-1"]);
    assert.equal(read(dir, "review-state.json").sources.find(s => s.file === "build-reviews-1.json").fetched, false);
  }
});

test("repeated and cyclic cursors stop with an explicit coverage failure", async (t) => {
  for (const cursors of [["100", "100"], ["100", "90", "100"]]) {
    const dir = fixture(t);
    let index = 0;
    const result = await dailyRunGather({ adminOutputDir: dir }, runner(() => page([], cursors[index++])));
    assert.equal(index, cursors.length);
    assert.equal(result.status, "partial_failure");
    assert.equal(result.data.buildReviews.complete, false);
    assert.match(result.data.steps.find(s => s.name === "build-reviews-pagination").error, /repeated/);
    const state = read(dir, "review-state.json");
    const progress = summarizeDailyProgress(dir, { ...state, requiredDuties: [] }, {
      protocol: 1,
      reading: state.sources.map(source => ({ ...source, complete: true, readAt: new Date().toISOString() })),
    });
    assert.equal(progress.reading.pending.length, 0);
    assert.deepEqual(progress.collectionFailures, ["build-reviews-pagination"]);
    assert.equal(progress.complete, false); // Reading the available pages cannot exhaust the missing queue.
    await dailyRunGather({ adminOutputDir: dir }, runner(() => page()));
    assert.deepEqual(read(dir, "review-state.json").collectionFailures, []);
  }
});

test("an endless changing cursor is bounded and never reported as exhausted", async (t) => {
  let cursor = 1000;
  const result = await dailyRunGather({ adminOutputDir: fixture(t) }, runner(() => page([], String(cursor--))));
  assert.equal(result.data.buildReviews.pages, 100);
  assert.equal(result.data.buildReviews.complete, false);
  assert.equal(result.status, "partial_failure");
  assert.match(result.data.steps.find(s => s.name === "build-reviews-pagination").error, /100-page limit/);
});

test("unconfirmed review reads retry once; review mutations never auto-retry", () => {
  for (const command of ["list", "approve", "reject", "revoke", "propose"]) {
    let calls = 0;
    const result = runAdmin(["review", command], {
      retryRead: true,
      spawnImpl: () => {
        calls++;
        return { status: 0, stdout: calls === 1 ? "" : JSON.stringify({ ok: true, status: "ok", data: page() }) };
      },
    });
    assert.equal(calls, command === "list" ? 2 : 1);
    assert.equal(result.ok, command === "list");
  }
});

test("priority collection defers evidence honestly; resume reuses verified receipts without acknowledging reading", async (t) => {
  const dir = fixture(t);
  const first = runner(() => page());
  const result = await dailyRunGather({ adminOutputDir: dir, adminPhase: "priority" }, first);
  assert.equal(result.status, "deferred");
  assert.equal(result.data.failed.length, 0);
  assert.ok(result.data.deferred.some(s => s.name === "bot-output-page-1"));
  assert.ok(!first.calls.some(args => args[0] === "bot-output"));
  assert.ok(first.calls.some(args => args[0] === "arena" && args[1] === "today-queue"));
  assert.ok(first.calls.some(args => args[0] === "nonogram"));
  const second = runner(() => page());
  const resumed = await dailyRunGather({ adminOutputDir: dir, adminPhase: "evidence", adminResume: true }, second);
  assert.equal(resumed.status, "success");
  assert.ok(!second.calls.some(args => args[0] === "energy-budget"));
  assert.ok(second.calls.some(args => args[0] === "bot-output"));
  assert.equal(resumed.data.collection.id, result.data.collection.id);
  const energy = resumed.data.steps.find(s => s.name === "energy-budget");
  assert.equal(energy.reused, true);
  assert.equal(energy.capturedAt, result.data.steps.find(s => s.name === "energy-budget").capturedAt);
  assert.ok(read(dir, "review-state.json").sources.every(s => !s.read));
});

test("bounded interruption resumes from persisted receipts, and modified or failed receipts are fetched again", async (t) => {
  const dir = fixture(t);
  const result = await dailyRunGather({ adminOutputDir: dir, adminMaxSteps: 2 }, runner(() => page()));
  assert.equal(result.status, "deferred");
  assert.equal(result.data.steps.filter(s => s.capturedAt).length, 2);
  fs.writeFileSync(path.join(dir, "energy-budget.json"), JSON.stringify({ ok: true, status: "ok", data: { wrong: true } }));
  const second = runner(() => page());
  const resumed = await dailyRunGather({ adminOutputDir: dir, adminResume: true }, second);
  assert.equal(resumed.status, "success");
  assert.ok(second.calls.some(args => args[0] === "energy-budget"));
  assert.ok(!second.calls.some(args => args[0] === "news"));
  const progress = summarizeDailyProgress(dir, read(dir, "review-state.json"), {});
  assert.equal(progress.complete, false);
  assert.ok(progress.reading.pending.length > 0);
});

test("closed UTC cost-day validation distinguishes run dates, rejects impossible dates and binds resumes", async (t) => {
  const now = () => Date.parse("2026-10-27T12:00:00Z");
  for (const date of ["2026-10-27", "2026-10-28", "2026-02-30", "2026-1-2"]) {
    const stub = runner(() => page());
    await assert.rejects(dailyRunGather({ adminOutputDir: fixture(t), adminCostDate: date }, { ...stub, now }), /completed UTC day/);
    assert.equal(stub.calls.length, 0);
  }
  const dir = fixture(t);
  const stub = runner(() => page());
  const result = await dailyRunGather({ adminOutputDir: dir, adminDate: "2026-10-26" }, { ...stub, now });
  assert.equal(result.data.costDateUtc, "2026-10-26");
  assert.match(result.data.collection.warnings[0], /legacy alias/);
  assert.ok(stub.calls.some(args => args[0] === "ai-costs" && args[2] === "2026-10-26"));
  await assert.rejects(dailyRunGather({ adminOutputDir: dir, adminResume: true, adminCostDate: "2026-10-25" }, { ...stub, now }), /different cost day/);
});

test("time budget leaves an explicit continuation instead of launching more child commands", async (t) => {
  let elapsed = 0;
  const stub = runner(() => page());
  const result = await dailyRunGather({ adminOutputDir: fixture(t), adminMaxSeconds: 1 }, {
    clock: () => elapsed,
    run(args, opts) { assert.ok(opts.timeoutMs <= 1000); const r = stub.run(args, opts); elapsed += 1000; return r; },
  });
  assert.equal(stub.calls.length, 1);
  assert.equal(result.status, "deferred");
  assert.ok(result.data.deferred.every(s => s.reason === "time-budget"));
});

test("a resumable page boundary follows the saved cursor, while semantic failures must be fetched again", async (t) => {
  const dir = fixture(t);
  let pageReads = 0;
  const first = runner(args => { pageReads++; return args.includes("--cursor") ? page([{ id: 2 }]) : page([{ id: 1 }], "100"); });
  // Stop immediately after the first review page; do not depend on the plan's length.
  let elapsed = 0;
  await dailyRunGather({ adminOutputDir: dir, adminMaxSeconds: 1 }, {
    clock: () => elapsed,
    run(args, opts) { const r = first.run(args, opts); if (args[0] === "review") elapsed = 1000; return r; },
  });
  assert.equal(pageReads, 1);
  const second = runner(args => { assert.ok(args.includes("--cursor")); return {}; });
  const failed = await dailyRunGather({ adminOutputDir: dir, adminResume: true }, second);
  assert.equal(failed.status, "partial_failure");
  assert.equal(read(dir, "gather-checkpoint.json").entries["build-reviews-page-2"].ok, false);
  const third = runner(args => { assert.ok(args.includes("--cursor")); return page([{ id: 2 }]); });
  const finished = await dailyRunGather({ adminOutputDir: dir, adminResume: true }, third);
  assert.equal(finished.status, "success");
  assert.deepEqual(finished.data.buildReviews, { complete: true, pages: 2, items: 2 });
  assert.equal(third.calls.length, 1);
});
