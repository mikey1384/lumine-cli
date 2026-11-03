import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { adminCommand, parseAdminOperation } from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";
import { runBatchedFeaturedHistory } from "../lib/admin-featured-history.js";
import {
  runAutomaticPagination,
  writePaginatedResultJson,
} from "../lib/admin-workflows.js";

function historyTestRoot() {
  const root = fileURLToPath(new URL("../work/featured-history-tests/", import.meta.url));
  mkdirSync(root, { recursive: true });
  return root;
}

function mockHistoryApi(t, { board = { ok: true, status: "success", data: { subjects: [{ id: 9 }, { id: 8 }], count: 2 } } } = {}) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const parsed = new URL(url);
    requests.push({ path: parsed.pathname, query: parsed.searchParams, ...init });
    let data;
    if (parsed.pathname === "/cli/session") {
      data = { userId: 7, username: "fixture", scopes: ["build:read"] };
    } else if (parsed.pathname === "/cli/admin/daily-runs/status") {
      data = { ok: true, status: "success", data: { run: { id: 91, status: "active", runScope: "featured", identity: { key: "zero" } } } };
    } else if (parsed.pathname === "/cli/admin/subjects/featured") {
      data = board;
    } else if (parsed.pathname === "/cli/admin/subjects/featured/history") {
      const ids = parsed.searchParams.get("subjectIds").split(",").map(Number);
      assert.ok(ids.length > 0);
      data = page(ids, parsed.searchParams.get("cursor"));
    } else {
      assert.fail(`Unexpected request: ${parsed.pathname}`);
    }
    return new Response(JSON.stringify(data), { status: 200 });
  });
  const messages = [];
  t.mock.method(console, "log", (...parts) => messages.push(parts.join(" ")));
  const run = (...args) => adminCommand({
    ...parseArgs(["admin", "featured", "history", ...args]),
    apiUrl: "https://history-fixture.invalid",
    authToken: "fixture-token",
    timeoutMs: 1000,
  });
  return { run, requests, messages, board };
}

test("no-ID history resolves the canonical current board and explains the selection in JSON and saved output", async (t) => {
  const dir = mkdtempSync(path.join(historyTestRoot(), "default-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { run, requests, messages } = mockHistoryApi(t);
  const output = path.join(dir, "history.json");
  const result = await run("--json", "--output", output);
  assert.deepEqual(result.data.subjectSelection.subjectIds, [9, 8]);
  assert.equal(result.data.subjectSelection.source, "current-featured-board");
  assert.match(result.data.subjectSelection.message, /Defaulted to the current Featured board/);
  assert.deepEqual(JSON.parse(messages[0]), result);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), result);
  const reads = requests.filter((r) => r.path.startsWith("/cli/admin/subjects/featured"));
  assert.deepEqual(reads.map((r) => r.path), ["/cli/admin/subjects/featured", "/cli/admin/subjects/featured/history"]);
  assert.equal(reads[1].query.get("subjectIds"), "9,8");
  assert.ok(reads.every((r) => r.method === "GET" && r.headers["x-lumine-admin-run-id"] === "91"));
});

test("current-board history pagination captures IDs once and retains its explanation in --all output", async (t) => {
  const dir = mkdtempSync(path.join(historyTestRoot(), "all-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { run, requests, messages, board } = mockHistoryApi(t);
  const output = path.join(dir, "history.json");
  const result = await run("--all", "--checkpoint", path.join(dir, "checkpoint.json"), "--output", output);
  const saved = JSON.parse(readFileSync(output, "utf8"));
  assert.deepEqual(saved.data.subjectSelection.subjectIds, [9, 8]);
  assert.equal(saved.data.events.length, 2);
  assert.equal(requests.filter((r) => r.path === "/cli/admin/subjects/featured").length, 1);
  assert.deepEqual(requests.filter((r) => r.path.endsWith("/history")).map((r) => r.query.get("subjectIds")), ["9,8", "9,8"]);
  assert.match(messages.join("\n"), /Defaulted to the current Featured board/);
  assert.deepEqual((await serialize(result)).data.subjectSelection, saved.data.subjectSelection);
  const resumed = await run("--all", "--resume", "--checkpoint", path.join(dir, "checkpoint.json"));
  assert.deepEqual(resumed.data.subjectSelection, saved.data.subjectSelection);
  assert.equal(requests.filter((r) => r.path.endsWith("/history")).length, 2);
  board.data.subjects.reverse();
  await assert.rejects(
    run("--all", "--resume", "--checkpoint", path.join(dir, "checkpoint.json")),
    /checkpoint/i,
  );
  assert.equal(requests.filter((r) => r.path.endsWith("/history")).length, 2);
});

test("explicit history IDs retain their scope and skip the board lookup", async (t) => {
  const { run, requests } = mockHistoryApi(t);
  const result = await run("--subject-ids", "3,2", "--cursor", "saved", "--json");
  assert.equal(result.data.subjectSelection, undefined);
  assert.ok(!requests.some((r) => r.path === "/cli/admin/subjects/featured"));
  const history = requests.find((r) => r.path.endsWith("/history"));
  assert.equal(history.query.get("subjectIds"), "3,2");
  assert.equal(history.query.get("cursor"), "saved");
});

test("an empty canonical board succeeds explicitly without requesting history or inventing coverage", async (t) => {
  const { run, requests, messages } = mockHistoryApi(t, { board: { ok: true, status: "success", data: { subjects: [], count: 0 } } });
  const result = await run();
  assert.deepEqual(result.data.subjectSelection.subjectIds, []);
  assert.equal(result.data.coverage, null);
  assert.deepEqual(result.data.events, []);
  assert.ok(!requests.some((r) => r.path.endsWith("/history")));
  assert.match(messages.join("\n"), /current Featured board, which is empty; no history was requested/);
  await assert.rejects(run("--all", "--resume"), /cannot supply the subject IDs/);
  await assert.rejects(run("--cursor", "prior"), /cannot supply the subject IDs/);
});

test("empty-board output cannot overwrite an existing pagination checkpoint", async (t) => {
  const dir = mkdtempSync(path.join(historyTestRoot(), "empty-output-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkpoint = path.join(dir, "checkpoint.json");
  const previous = JSON.stringify({ confirmedProgress: "keep this checkpoint" });
  writeFileSync(checkpoint, previous);
  const { run, requests } = mockHistoryApi(t, {
    board: { ok: true, status: "success", data: { subjects: [], count: 0 } },
  });
  await assert.rejects(
    run("--all", "--checkpoint", checkpoint, "--output", checkpoint, "--json"),
    /checkpoint and result output must use different files/,
  );
  assert.equal(readFileSync(checkpoint, "utf8"), previous);
  const output = path.join(dir, "empty-history.json");
  const result = await run("--all", "--checkpoint", checkpoint, "--output", output, "--json");
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), result);
  assert.equal(result.data.coverage, null);
  assert.equal(readFileSync(checkpoint, "utf8"), previous);
  assert.ok(!requests.some((r) => r.path.endsWith("/history")));
});

test("a failed or malformed board read never becomes an empty successful history", async (t) => {
  for (const board of [
    { ok: false, status: "error", data: { subjects: [], count: 0 } },
    { ok: true, status: "success", data: {} },
    { ok: true, status: "success", data: { subjects: [{ id: "9" }], count: 1 } },
    { ok: true, status: "success", data: { subjects: [{ id: 9 }], count: 2 } },
    { ok: true, status: "success", data: { subjects: [{ id: 9 }, { id: 9 }], count: 2 } },
  ]) {
    const { run, requests } = mockHistoryApi(t, { board });
    await assert.rejects(run(), /history was not requested/);
    assert.ok(!requests.some((r) => r.path.endsWith("/history")));
  }
});

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
  const dir = mkdtempSync(path.join(historyTestRoot(), "lumine-history-batches-"));
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
  const dir = mkdtempSync(path.join(historyTestRoot(), "lumine-history-single-"));
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
