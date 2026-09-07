import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseAdminOperation } from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";
import { runBatchedFeaturedHistory } from "../lib/admin-featured-history.js";
import {
  runAutomaticPagination,
  writePaginatedResultJson,
} from "../lib/admin-workflows.js";

function operation(ids) {
  return {
    name: "featured.history",
    path: `/cli/admin/subjects/featured/history?subjectIds=${ids.join(",")}&limit=1`,
    pagination: {
      collectionKey: "events",
      summaryKeys: ["coverage", "subjects"],
      filters: { subjectIds: ids },
    },
  };
}
function page(ids, cursor) {
  return {
    ok: true,
    status: "success",
    data: {
      coverage: { complete: true, startedAt: 100, updatedAt: 101 },
      subjects: ids.map((id) => ({
        id,
        neverFeatured: id !== ids[0] ? true : false,
      })),
      events: [{ id: ids[0] * 10 + (cursor ? 0 : 1), subjectId: ids[0] }],
      pagination: {
        exhausted: !!cursor,
        hasMore: !cursor,
        nextCursor: cursor ? null : "page2",
        snapshotMaxId: ids[0] * 10 + 1,
        snapshotTimeStamp: null,
        after: null,
        scannedCount: 1,
      },
    },
  };
}
async function serialize(result) {
  let output = "";
  await writePaginatedResultJson({
    result,
    write: async (chunk) => {
      output += chunk;
    },
  });
  return JSON.parse(output);
}

test("history batches preserve summaries and resume a failed page without repeating confirmed events", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lumine-history-batches-"));
  const ids = Array.from({ length: 201 }, (_, i) => i + 1);
  const options = {
    apiUrl: "https://api.example",
    adminCheckpoint: path.join(dir, "scan.json"),
    adminOutput: path.join(dir, "out.json"),
  };
  const calls = [];
  let fail = true;
  const args = {
    options,
    operation: operation(ids),
    runId: 76,
    transformPage: (result) => result,
    fetchPage: async (requestPath) => {
      const url = new URL(requestPath, "https://api.example");
      const batchIds = url.searchParams
        .get("subjectIds")
        .split(",")
        .map(Number);
      assert.ok(batchIds.length <= 100);
      const cursor = url.searchParams.get("cursor");
      calls.push([batchIds[0], cursor]);
      if (fail && batchIds[0] === 101 && cursor)
        throw new Error("transient read failure");
      return page(batchIds, cursor);
    },
  };
  await assert.rejects(
    runBatchedFeaturedHistory(args),
    /transient read failure/,
  );
  fail = false;
  calls.length = 0;
  const result = await runBatchedFeaturedHistory({
    ...args,
    options: { ...options, adminResume: true },
  });
  assert.deepEqual(calls, [
    [101, "page2"],
    [201, null],
    [201, "page2"],
  ]);
  const json = await serialize(result);
  assert.deepEqual(
    json.data.subjects.map((subject) => subject.id),
    ids,
  );
  assert.deepEqual(
    json.data.events.map((event) => event.id),
    [11, 10, 1011, 1010, 2011, 2010],
  );
  assert.equal(json.data.pagination.snapshotMaxId, null);
  assert.equal(json.data.pagination.snapshotScope, "per-batch");
  assert.equal(json.data.scan.batches.length, 3);
  assert.deepEqual(JSON.parse(readFileSync(options.adminOutput, "utf8")), json);
  calls.length = 0;
  const resumed = await serialize(
    await runBatchedFeaturedHistory({
      ...args,
      options: { ...options, adminResume: true },
    }),
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(resumed.data.subjects, json.data.subjects);
  assert.deepEqual(resumed.data.events, json.data.events);
  await assert.rejects(
    runBatchedFeaturedHistory({
      ...args,
      operation: operation(ids.slice(1)),
      options: { ...options, adminResume: true },
    }),
    /exact history request/,
  );
  // Starting a fresh scan at the same checkpoint must never reuse completed
  // batches from the previous generation after an interruption.
  fail = true;
  await assert.rejects(
    runBatchedFeaturedHistory(args),
    /transient read failure/,
  );
  fail = false;
  calls.length = 0;
  await runBatchedFeaturedHistory({
    ...args,
    options: { ...options, adminResume: true },
  });
  assert.deepEqual(calls, [
    [101, "page2"],
    [201, null],
    [201, "page2"],
  ]);
});

test("history above the API read bound requires the automatic scan path", () => {
  const ids = Array.from({ length: 101 }, (_, i) => i + 1).join(",");
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "featured", "history", "--subject-ids", ids]),
      ),
    /--all/,
  );
  assert.equal(
    parseAdminOperation(
      parseArgs([
        "admin",
        "featured",
        "history",
        "--subject-ids",
        ids,
        "--all",
      ]),
    ).pagination.filters.subjectIds.length,
    101,
  );
});

test("completed single-batch history resumes with its coverage and subject summaries", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lumine-history-single-"));
  const args = {
    options: { adminCheckpoint: path.join(dir, "scan.json") },
    operation: operation([1, 2]),
    runId: 76,
    fetchPage: async (requestPath) =>
      page(
        [1, 2],
        new URL(requestPath, "https://api.example").searchParams.get("cursor"),
      ),
    transformPage: (result) => result,
  };
  const original = await serialize(await runAutomaticPagination(args));
  const resumed = await serialize(
    await runAutomaticPagination({
      ...args,
      options: { ...args.options, adminResume: true },
      fetchPage: async () => assert.fail("completed scan must not refetch"),
    }),
  );
  assert.deepEqual(resumed.data.subjects, original.data.subjects);
  assert.deepEqual(resumed.data.coverage, original.data.coverage);
  assert.deepEqual(resumed.data.events, original.data.events);
});
