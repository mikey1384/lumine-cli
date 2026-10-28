import assert from "node:assert/strict";
import test from "node:test";
import { summarizeGameDiagnostics } from "../lib/game-diagnostic-summary.js";

const entry = (id, data = {}, canonical = {}) => ({ id, userId: 77, topicId: 335,
  data: { artifactVersionId: 16292, kind: "save-failed", eventId: "session:1", ...data }, ...canonical });
const summarize = (entries, extra = {}) => summarizeGameDiagnostics({ buildId: 2610,
  topic: "ashen-net-telemetry", entries, ...extra });

test("lost-ack retries count once while delivery snapshots and the raw input remain intact", () => {
  const source = [entry(1, { delivery: { v: 1, attempt: 1, requestFailures: 0, acknowledged: 0 }, msg: "private error text" }),
    entry(2, { msg: "private error text", delivery: { acknowledged: 2, attempt: 2, requestFailures: 1, v: 1 } })];
  source[0].username = "private-name";
  const before = JSON.stringify(source);
  const result = summarize(source, { coverage: { complete: false, since: 10, until: 20 } });
  assert.equal(result.deduplication.uniqueStableEvents, 1);
  assert.equal(result.deduplication.retryDuplicateReceipts, 1);
  assert.equal(result.counts.byKind["save-failed"], 1);
  assert.deepEqual(result.collection, { complete: false, since: 10, until: 20 });
  assert.equal(result.delivery.totalObservations, 2);
  assert.equal(result.delivery.observations[0].delivery.requestFailures, 1);
  assert.equal(JSON.stringify(source), before);
  assert.doesNotMatch(JSON.stringify(result), /private error text|private-name/);
});

test("canonical actor, topic and artifact scope prevent merging; payload viewerId cannot substitute", () => {
  const result = summarize([entry(1, { viewerId: 77 }), entry(2, { viewerId: 77 }, { userId: 88 }),
    entry(3, { viewerId: 77, artifactVersionId: 16293 }), entry(4, { viewerId: 77 }, { topicId: 336 })]);
  assert.equal(result.deduplication.uniqueStableEvents, 4);
  assert.equal(result.deduplication.retryDuplicateReceipts, 0);
  assert.throws(() => summarize([entry(1, { viewerId: 77 }, { userId: null })]), /canonical positive/);
  assert.throws(() => summarize([entry(1, {}, { buildId: 2 })]), /does not match/);
  assert.equal(summarize([entry(1)], { buildId: 2 }).buildId, 2);
});

test("semantic collisions and unknown delivery fields are flagged, never silently counted as recovery", () => {
  for (const rows of [
    [entry(1), entry(2, { kind: "save-ok" })],
    [entry(1, { delivery: { customOutcome: "first" } }), entry(2, { delivery: { customOutcome: "second" } })],
    [entry(1, { saveDiagnostic: { operationId: "a" } }), entry(2, { saveDiagnostic: { operationId: "b" } })]
  ]) {
    const result = summarize(rows);
    assert.equal(result.deduplication.collisionGroups, 1);
    assert.equal(result.deduplication.collidingReceipts, 2);
    assert.equal(result.deduplication.countedEvents, 0);
    assert.equal(result.deduplication.coverage, "partial");
    assert.equal(result.deduplication.collisions[0].variants.length, 2);
    assert.deepEqual(result.counts.byKind, {});
  }
});

test("Alzebra batches and soundtrack counters deduplicate by stable identity with semantic key ordering", () => {
  const a = { schema: 1, batchId: "batch:1", artifactVersionId: 16289, events: [{ name: "save_status", state: "conflict" }] };
  const b = { events: [{ state: "conflict", name: "save_status" }], artifactVersionId: 16289, batchId: "batch:1", schema: 1 };
  const result = summarize([entry(1, {}, { data: a }), entry(2, {}, { data: b })]);
  assert.equal(result.deduplication.uniqueStableEvents, 1);
  assert.equal(result.counts.alzebraEventNames.save_status, 1);
  const counters = { "progress-save": { count: 4, failed: 1, durationMs: 15, maxMs: 7 } };
  const soundtrack = summarize([entry(3, { kind: "soundtrack-diagnostics", counters }), entry(4, { kind: "soundtrack-diagnostics", counters })]);
  assert.deepEqual(soundtrack.counts.soundtrackCounters["progress-save"], counters["progress-save"]);
});

test("legacy and unknown-version coverage stays explicit; repeated page entries are not additional retries", () => {
  const first = entry(1);
  const result = summarize([first, structuredClone(first), entry(2, {}, { data: { kind: "save-failed" } }),
    entry(3, {}, { data: { kind: "save-failed" } }), entry(4, { artifactVersionId: null })]);
  assert.equal(result.rows.duplicateInputRows, 1);
  assert.equal(result.rows.legacyRows, 2);
  assert.equal(result.rows.unknownArtifactRows, 3);
  assert.equal(result.deduplication.retryDuplicateReceipts, 0);
  assert.equal(result.deduplication.countedEvents, 4);
  assert.equal(result.deduplication.coverage, "partial");
  assert.throws(() => summarize([first, entry(1, { kind: "save-ok" })]), /Conflicting copies/);
  assert.equal(summarize([]).deduplication.coverage, "empty");
});

test("malformed identity, oversized/deep JSON and invalid coverage fail with bounded output", () => {
  for (const row of [entry(1, { eventId: "bad id" }), entry(1, { artifactVersionId: "16292" }),
    entry(1, { extra: "x".repeat(16384) }), entry(1, {}, { topicId: 0 })]) assert.throws(() => summarize([row]));
  const deep = {}; let current = deep;
  for (let i = 0; i < 40; i++) current = current.next = {};
  assert.throws(() => summarize([entry(1, { deep })]), /depth/);
  assert.throws(() => summarize([], { coverage: { complete: "yes" } }), /boolean/);
  assert.throws(() => summarize([], { coverage: { since: 20, until: 10 } }), /after/);
  assert.throws(() => summarize(Array(10001).fill(entry(1))), /10000/);
  const rows = Array.from({ length: 110 }, (_, i) => entry(i + 1, { eventId: `session:${i}`, delivery: { attempt: 1 } }));
  const bounded = summarize(rows);
  assert.equal(bounded.delivery.totalObservations, 110);
  assert.equal(bounded.delivery.observations.length, 100);
  assert.equal(bounded.delivery.omittedObservations, 10);
});
