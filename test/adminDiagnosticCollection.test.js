import assert from "node:assert/strict";
import test from "node:test";
import { collectDiagnosticPages, diagnosticCollectionSummary } from "../lib/admin-diagnostic-collection.js";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";

function collect(pages, ownerTrace = false, jevReview = false) {
  const calls = [], failures = [];
  const result = collectDiagnosticPages({ name: "test", command: ["test"], since: 10, until: 20, ownerTrace, jevReview,
    step(name, args, file) {
      calls.push({ name, args, file });
      const value = pages.shift();
      return value?.ok === false ? value : { ok: true, json: { data: { since: 10, until: 20, ...value } } };
    }, failLast: message => failures.push(message) });
  return { result, calls, failures };
}

test("all reward pages keep their exact boundary and source receipts, deduplicating only by event ID", () => {
  const { result, calls, failures } = collect([
    { events: [{ id: 8 }, { id: 7 }], nextCursor: 7 },
    { events: [{ id: 7 }, { id: 6 }], nextCursor: 6 },
    { events: [{ id: 5 }], nextCursor: null },
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.duplicateRows, 1);
  assert.deepEqual(result.events.map(e => e.id), [8, 7, 6, 5]);
  assert.ok(calls.every(c => c.args[c.args.indexOf("--until") + 1] === "20"));
  assert.deepEqual(calls.map(c => c.file), ["test.json", "test-2.json", "test-3.json"]);
  assert.deepEqual(failures, []);
  const compact = diagnosticCollectionSummary(result);
  assert.equal(compact.events, undefined);
  assert.equal(compact.rows, 4);
});

const jevCursor = (id, createdAt = 15) => Buffer.from(JSON.stringify({ version: 1,
  kind: "jev-routing-review", since: 10, until: 20, includeSynthetic: false, createdAt, id })).toString("base64url");
const jevPage = (items, nextCursor = null, after = null) => ({ items, nextCursor, after,
  collectionWindow: { since: 10, until: 20, includeSynthetic: false }, hasMore: nextCursor !== null,
  coverage: { scope: "page", status: nextCursor === null ? "exhausted" : "partial" } });

test("JEV collection retains all fixed-window pages and deduplicates overlapping review reasons by event", () => {
  const cursor = jevCursor(2);
  const { result, failures } = collect([
    jevPage([{ eventId: 1 }, { eventId: 2 }], cursor),
    jevPage([{ eventId: 2 }, { eventId: 3 }], null, cursor),
  ], false, true);
  assert.equal(result.complete, true);
  assert.equal(result.duplicateRows, 1);
  assert.equal(result.pages, 2);
  assert.deepEqual(result.events.map(row => row.eventId), [1, 2, 3]);
  assert.deepEqual(failures, []);
});

test("JEV collection rejects changed filters, missing exhaustion and backward cursors", () => {
  for (const bad of [
    { ...jevPage([]), collectionWindow: { since: 10, until: 20, includeSynthetic: true } },
    { ...jevPage([]), coverage: undefined },
    { ...jevPage([]), nextCursor: undefined },
    { ...jevPage([]), after: "unexpected" },
  ]) {
    const { result, failures } = collect([bad], false, true);
    assert.equal(result.complete, false);
    assert.equal(failures.length, 1);
  }
  const { result, failures } = collect([
    jevPage([{ eventId: 2 }], jevCursor(2)),
    jevPage([{ eventId: 1 }], jevCursor(1), jevCursor(2))
  ], false, true);
  assert.equal(result.complete, false);
  assert.match(failures[0], /did not advance/);
});

test("CLI wires the bounded JEV review command and explicit synthetic flag", () => {
  const options = parseArgs(["admin", "jev-routing", "review", "--since", "2026-10-27", "--until", "2026-10-28", "--include-synthetic"]);
  const op = parseAdminOperation(options);
  assert.equal(op.name, "jevRouting.review");
  assert.equal(op.mutates, false);
  assert.match(op.path, /includeSynthetic=true/);
});

test("wake pages preserve same-second rows and return a chronological aggregate", () => {
  const { result, failures } = collect([
    { events: [{ id: 9, serverTime: 19 }, { id: 10, serverTime: 19 }], nextCursor: "19:9", truncated: true },
    { events: [{ id: 7, serverTime: 18 }, { id: 8, serverTime: 19 }], nextCursor: null, truncated: false },
  ], true);
  assert.equal(result.complete, true);
  assert.deepEqual(result.events.map(e => e.id), [7, 8, 9, 10]);
  assert.deepEqual(failures, []);
});

test("a later failure/deferment retains observed rows but cannot become complete coverage", () => {
  for (const failure of [{ ok: false }, { ok: false, deferred: true, reason: "step-budget" }]) {
    const { result } = collect([{ events: [{ id: 9 }], nextCursor: 9 }, failure]);
    assert.equal(result.complete, false);
    assert.equal(result.truncated, true);
    assert.equal(result.rows, 1);
    assert.equal(result.deferred, Boolean(failure.deferred));
  }
});

test("drifting/missing windows, unavailable instrumentation and repeated cursors fail explicitly", () => {
  for (const bad of [
    { events: [], nextCursor: null, until: 21 },
    { events: [], nextCursor: null, since: undefined },
    { events: [], nextCursor: null, coverage: "unavailable" },
    { events: [], nextCursor: undefined },
    { events: [{ id: null }], nextCursor: null },
  ]) {
    const { result, failures } = collect([bad]);
    assert.equal(result.complete, false);
    assert.equal(failures.length, 1);
  }
  const repeated = collect([{ events: [{ id: 9 }], nextCursor: 9 }, { events: [{ id: 9 }], nextCursor: 9 }]);
  assert.equal(repeated.result.complete, false);
  assert.equal(repeated.failures.length, 1);
});

test("CLI forwards fixed diagnostic windows and owner-trace tuple cursors without losing precision", () => {
  const owner = parseAdminOperation(parseArgs(["admin", "owner-trace", "--since", "1800000000", "--until", "1800000100", "--cursor", "1800000099:12"]));
  assert.match(owner.path, /until=1800000100/);
  assert.match(owner.path, /cursor=1800000099%3A12/);
  const reward = parseAdminOperation(parseArgs(["admin", "reward-diagnostics", "--until", "1800000100", "--cursor", "12"]));
  assert.match(reward.path, /until=1800000100/);
  assert.match(reward.path, /before=12/);
  assert.throws(() => parseAdminOperation(parseArgs(["admin", "owner-trace", "--cursor", "12"])), /cursor/);
});
